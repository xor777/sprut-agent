import {
  CHARACTERISTIC_HOLD,
  publishedBlockNodes,
  TIME_TRIGGER,
} from "./block-model.mjs";
import { refuseRedactionMark } from "./change-refs.mjs";
import {
  isSelectableNativeValidValue,
  nativeScalarContract,
  validateNativeScalarValue,
} from "./native-option-contract.mjs";
import { SprutHubError, sanitizeNativeData } from "./spruthub-client.mjs";

// SprutHub 3.0.0 keeps the first 32 characters of a room name, Cyrillic and
// Latin alike (characters, not bytes); the room.create answer already
// carries the kept name, and the one emoji tried (🙂, outside the Basic
// Multilingual Plane) was dropped (owner hub, 2026-09-24,
// research/protocol/2026-09-24-live-conformance-3.md). Characters are
// counted as Unicode code points. As a precaution, every character outside
// the BMP, every emoji and pictograph inside it (❤, ⭐, ☀) and the variation
// selectors that turn a symbol into an emoji are refused; which of them the
// hub drops was not checked.
export const ROOM_NAME_MAX_LENGTH = 32;

export const ROOM_NAME_REFUSED_CHARACTER =
  /\p{Extended_Pictographic}|[\uFE00-\uFE0F]/u;

export const ROOM_NAME_LIMIT_NOTE = `SprutHub keeps the first ${ROOM_NAME_MAX_LENGTH} characters of a room name and dropped an emoji from one, so a longer name, or one with emoji, pictographs, variation selectors or other characters outside the Basic Multilingual Plane, is refused before any write (only one emoji was seen dropped; the rest are refused as a precaution). A stored name that still differs from the request is reported: name_normalized for room_create, uncertain for room_name.`;

export function accessoryPlacementContract(accessory) {
  return {
    current: {
      name: accessory.name,
      room_id: accessory.roomId,
    },
    write: "accessory.update({id,name,roomId})",
    scope: "one_accessory",
    confirmation: "empty_ack_then_separate_accessory_get",
    restore: "saved_name_and_room_only_while_applied_snapshot_matches",
    limitations: [
      "Services and other accessories sharing the same physical device are not changed.",
      "SprutHub may normalize the requested name; the observed saved name is reported separately.",
      "SprutHub exposes no native compare-and-set; a race remains after the pre-write comparison.",
    ],
  };
}

export function roomCreateContract() {
  return {
    write: "room.create({name})",
    name: { min_length: 1, ...roomNameLimits() },
    response: "RoomMessage",
    confirmation: "separate_room_get",
    restore:
      "delete_only_a_confirmed_created_room_with_unchanged_configuration_and_no_accessories",
    evidence: {
      create_request: "official_frontend",
      create_response: "bundled_official_protobuf_schema",
      live_create: "SprutHub 3.0.0 rev 20131, 2026-09-24",
    },
    limitations: [
      ROOM_NAME_LIMIT_NOTE,
      "A lost create response cannot establish ownership from a matching name alone and is never retried blindly.",
      "Room deletion is not attempted when creation ownership, unchanged configuration, or emptiness is unconfirmed.",
    ],
  };
}

export function virtualLightGroupContract() {
  return {
    write: [
      "accessory.create({name,roomId,services:[{type:'Lightbulb',name,optional:['Brightness']}]})",
      "link.addVirtual({aId,sId,cId,tAId,tSId,tCId})",
      "characteristic.update({aId,sId,cId,hasLinks:true})",
      "link.remove({aId,sId,cId,linkId})",
      "characteristic.update({aId,sId,cId,hasLinks:false})",
    ],
    scope: "one_created_virtual_light_and_explicit_member_services",
    existing_group:
      "To change the lamps of an existing group (find_devices marks it with lamp_group), read this contract with target_ref = the group's lamp service: it lists the group's lamps and what it links.",
    characteristics: ["On", "Brightness"],
    feedback: "LAST_VALUE",
    restore:
      "remove_owned_in_links_disable_hasLinks_verify_physical_out_absence_then_delete_confirmed_created_accessory",
    evidence: {
      create_and_link_requests: "current_official_frontend",
      request_and_response_shapes: "current_bundled_official_protobuf_schema",
      existing_native_group_read: true,
      live_create_and_link: true,
      live_same_value_repeat_delivery: false,
      ui_ordered_link_cleanup_requires_live_recheck: true,
    },
    limitations: [
      "Creation and every link are sequential native writes, not one atomic transaction: when the hub refuses a later step, the earlier ones stay, apply answers hub_effect=partial with change showing them, and next is restore_native_change to remove them.",
      "A lost accessory-create response does not establish ownership from a matching candidate and is never retried blindly.",
      "A same-valued virtual command can be acknowledged without reaching every member; member readback is required.",
      "SprutHub exposes no native compare-and-set; a race remains after each pre-write observation.",
    ],
  };
}

export function requiredNativeName(value, operation) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SprutHubError(
      "name_required",
      `A non-empty name is required for ${operation}.`,
      "prepare_native_change",
    );
  }
  return value;
}

export function blockContract() {
  return {
    version: "2026-09-24",
    source: {
      frontend_sha256:
        "81c1ef74ce21eb5ccff583255ba82fe766ff4cf6bc251c0566b7bd67436647f8",
      scenario_proto_sha256:
        "2319535876324b44c2048267d8b4297ec48d0881b964d5acc5ed1cbddfaa3657",
    },
    update: "scenario.update({index,data})",
    supported: {
      root: { required: ["targets"] },
      target_types: ["if", "service", "delay", "scenario", "clear_delay"],
      condition_modes: ["AND", "OR"],
      if_modes: ["EVERY", "ONCE"],
      action_types: ["set", "toggle", "inc", "dec"],
      delay_modes: ["RESET", "CONTINUE"],
      delay_index: { type: "integer", minimum: 1, unique: true },
      characteristic_conditions: {
        boolean: ["="],
        string_or_enum: ["=", "!="],
        number: ["=", "!=", ">", ">=", "<", "<="],
        hold: structuredClone(CHARACTERISTIC_HOLD),
      },
      daily_interval: {
        local_time: "HH:mm",
        start_and_end: "distinct",
        crosses_midnight: true,
        native_trigger: true,
        cron: {
          format: "0 MM HH ? * * *",
          fields: {
            MM: "minute_0_to_59",
            HH: "hour_0_to_23",
          },
          seconds: 0,
          mode: "NONE",
          offset: 0,
        },
        native_shape: {
          type: "interval",
          start: {
            type: "cron",
            mode: "NONE",
            cron: "0 MM HH ? * * *",
            offset: 0,
          },
          end: {
            type: "cron",
            mode: "NONE",
            cron: "0 MM HH ? * * *",
            offset: 0,
          },
          trigger: true,
        },
        boundaries: {
          start: "enter_interval",
          end: "leave_interval",
          clock: "selected_hub_local_wall_clock",
        },
        branch_semantics: {
          sole_interval_condition: "start_then_end_else",
          compound_condition:
            "boundary_rechecks_complete_condition_tree_then_selects_result_branch",
        },
      },
      time_trigger: structuredClone(TIME_TRIGGER),
      nesting: [
        "if.if",
        "if.then",
        "if.else",
        "delay.targets",
        "condition.conditions",
        "interval.start",
        "interval.end",
      ],
      nodes: publishedBlockNodes(),
    },
    limitations: [
      "BLOCK data uses native IDs inside one configured home; preparation verifies each referenced characteristic.",
      "block_create reads the BLOCK scenarios the hub lists for the devices it writes: one that already sets the same characteristic to the same value on the same trigger is named in existing_rules (same, superset or partial) with tell_owner. Do not apply a second scenario unless the owner asked for one; change the existing one with block_data_update instead.",
      "block_create needs at least one trigger: a characteristic or daily interval with trigger=true, or a time_trigger cron; its action-only form accepts only literal Lightbulb On=false service/set targets. block_data_update refuses an edit that removes the last trigger. A stored BLOCK without a trigger runs only when started manually or by another scenario; it stays editable, and block_action_preview.triggers says so.",
      "block_data_update checks only what the edit adds or changes. A subtree that means the same as a stored one under the same parent fields and node types is written exactly as the hub stores it, with its blockIds, if.state and if fields, wherever it sits in its array and whatever form the edit gave it; diff.data.to shows what is written, and each stored subtree matches once. Here, as in readback and restore, BLOCK data is compared without blockId and if.state, with a null field as left out (the hub drops null fields), an if's left-out mode as EVERY, left-out then_delay and else_delay as 0, else null or left out as [], a from action's value \"\" as left out, and a condition group of one condition with mode OR as AND; any other difference is an edit. Stored code and other nodes outside this contract therefore stay, but cannot be added, changed or moved under another parent, and a node with a changed descendant is checked itself. An edited node is compared with the stored node it was edited from: the one with the same blockId (keep the blockId get_entity returned), else the one with the same aId/sId/cId or index, else for a device action one of the same device, first one that sets a characteristic it sets, else for an if or a condition group the one that shares the most of its conditions, an if's branch actions and the group's mode (a mode alone pairs nothing), else the next one of its type in order. Delay indexes, clear_delay references, pause controllers, scenario runs and whether every aId/sId/cId still names a characteristic of its hs/hc are checked over the whole data. Kept actions whose rights or value this contract would refuse are listed in block_action_preview.unchecked_actions instead of actions. block_action_preview.removed_nodes lists the stored nodes the edit removes, with pointers into diff.data.from; a limitation names removed code, other nodes this contract cannot write and requests whose URL answers hide, which only restore or the SprutHub interface bring back. block_action_preview.warnings (or_group_grown) names a condition group the edit grows from one condition to several while its mode stays OR, as the web client makes every group: any one condition then runs the branch; tell the owner or set AND.",
      "Without blockIds, an edited node is matched to the stored node it came from by content, which can be approximate. That match names removed_nodes and or_group_grown, and it also decides which stored nodes the edit keeps as stored, such as code and unchecked_actions: a merge of rules may then be refused at stored code, or check a kept action as new. Keep the blockIds from the read for exact matching.",
      "Restore of block_data_update writes the stored original back; it checks again the pause controllers, actions moved out of an ended pause, scenario runs and that every aId/sId/cId still names a characteristic of its hs/hc.",
      "A refusal lists every failing rule in problems, each with one reason and an RFC 6901 pointer into data.",
      "A supported characteristic directly in if.if is written as condition/AND with that one leaf, or as the stored group with that leaf when an update keeps it; existing AND/OR groups are not rewrapped.",
      "Daily interval and time_trigger times use the selected hub's local wall clock. The hub's time zone (TimeZone) and current time (Time) are in the home settings window: get_entity on the home's options_window_ref from home_overview. Convert a time given in another zone only after reading them.",
      "time_trigger days_at_time, every_n_hours, every_n_minutes, every_n_seconds and sun follow what the official web client writes: day names in field 5 with all seven sent as *, every N as 0/N with the editor's N list, and a SUNRISE/SUNSET offset in seconds (negative is before). one_date is only in the editor schema; the web client never writes it. SprutHub 3.0.0 stored days_at_time, every_n_minutes, one_date and sun as sent, and a days_at_time for every day fired at its minute of the hub clock; firing of the other forms is not observed, so check read_hub_log after the first expected moment.",
      "A time_trigger cron has no trigger flag and fires its BLOCK at its moment; how it evaluates when another trigger of the same condition fires is not observed. one_date is not checked against the hub clock, and a past date never fires.",
      "Daily interval creation and readback confirm stored native configuration, not firing at a minute boundary, immediate behavior when created inside the interval, or runtime across midnight.",
      "The same characteristic cannot be both a condition and an action in this slice, unless the edit keeps both as stored.",
      "toggle (boolean), inc and dec (numeric without listed values, value is a positive number step in the characteristic's unit, at most its max minus min and a multiple of its minStep) are stored as sent on SprutHub 3.0.0; a hub has not been observed running them, including whether a step clamps at the characteristic's range. A step is a number or a plain decimal string such as \"10\", and is sent as a number, the form the hub stores.",
      "A scenario target names an existing scenario of this home by its index and a mode from the web client: FIRE runs it, ACTIVATE turns it on, DEACTIVATE turns it off, ACTIVATE_AND_FIRE turns it on and runs it, RESET resets it (known only from the editor label «Сбросить»). A target that runs (FIRE, ACTIVATE_AND_FIRE) must not run its own BLOCK, directly or through running scenario targets of other BLOCKs; the chain is followed through up to 8 scenarios, a longer chain or unreadable BLOCK data is refused, and scenarios run from LOGIC code are not followed. A BLOCK may turn itself off. The modes follow the official editor; SprutHub 3.0.0 stored ACTIVATE, DEACTIVATE, ACTIVATE_AND_FIRE and RESET as sent, and a hub has not been observed running any of them, including for a turned-off scenario.",
      'if mode ONCE, delay mode CONTINUE, clear_delay and a characteristic hold follow what the official web client writes; a hub has not been observed running them. A hold is timeCond ">" (has not changed for) or "<" (changed back within) with time in milliseconds; what "<" does on the hub is known only from the client label. An if without mode is EVERY; an if may leave out else or set it to null for no else branch, and may leave out then_delay and else_delay, which mean 0 (SprutHub 3.0.0 stores such an if with mode EVERY, both delays 0 and no else). A positive then_delay or else_delay repeats that branch every so many milliseconds, at least 1000 («Каждые» in the web client); SprutHub 3.0.0 stored such a period as sent, and how long a hub keeps repeating it is not observed. The web client labels RESET "single timer" and CONTINUE "new timer", so CONTINUE is expected to start another delay for each entry and run its actions once per entry.',
      "notify sends its text as a notification, as the web client writes it. Mode PUSH goes through the home's notification services (extensions with bundle_type NOTIFICATION in home_overview list=extensions): to null or left out for all of them, or [{index, clients}] with a service's index and clients null or left out for all its recipients, or recipient ids from get_entity include children. Mode MESSAGE is the editor's «Системное» notification without recipients; where the hub shows it is not known. The text is the owner's message, sent as written; [REDACTED] is refused. block_action_preview.notifications shows each notification the change adds or changes, with its text and the services it goes through with enabled, state and, for all their recipients, recipient_count as read at preparation. Its warnings name a service that is not enabled or not LOADED (service_not_ready), has no recipients (no_recipients) or whose recipients could not be read (recipients_unread, with recipient_count null), and a PUSH to all services of a home without one (no_notification_services): such a notification may reach no one, so tell the owner instead of promising it. Recipients named by id are checked against the service and refused when they cannot be read. SprutHub 3.0.0 stored MESSAGE and PUSH notifications without to null and clients null, which it drops; it has not been observed sending one.",
      'from («Установить из» in the web client) sets the target to the current value of another characteristic when the action runs: {type:"from", cId, hc, from_aId, from_sId, from_cId, from_hs, from_hc}, with value "" as the web client writes it or left out, and with the source\'s ids and its service and characteristic types from get_entity. The source must be readable, hold the same kind of value (yes/no, number or text) and not be the target itself; a target with listed values (a mode) takes them only from a characteristic of its own type. A value outside the target\'s range is not checked in advance, and what the hub does with it is not observed; nor is how it rounds a fractional source, such as a temperature, copied into a whole-number target, such as a brightness. A refused source is named with its reason: not readable, a value of no supported kind, or listed values of another kind. block_action_preview shows the source with its value at preparation. A summary names the source, and the source device\'s relations name the rule with role source when the hub\'s scenario index lists the rule for that device, which is not observed for a device that is only a source. SprutHub 3.0.0 stored a from action without value "", which it drops; it has not been observed running one.',
      "http makes a request with a method from the web client's list to an absolute http or https URL, with no body or headers, as the web client writes it. Any such URL is accepted: what the BLOCK calls, such as a device on the home network or a webhook, is the owner's request. A URL with a user name or password is refused. A key may sit in the path (Telegram /bot<token>/, webhook ids) or under any query name, so no answer repeats a URL: block_action_preview.http_requests and the summary show method, scheme and host of each request with path and query marked not_shown, and get_entity configuration and diffs show every URL other than scheme and host as [REDACTED]. An edit that sends [REDACTED] back keeps the stored URL only on the one node that carries its blockId from get_entity; [REDACTED] anywhere else, as in a copy of the node, is refused at its pointer. SprutHub 3.0.0 stored a request as sent and has not been observed sending one; a scenario_run of a BLOCK with a request has no known targets.",
      "clear_delay cancels a delay of the same BLOCK by its index, which must belong to a delay in the data, or all its delays with index 0.",
      "Name and Desc are separate window_option writes on the owning scenario ref; this operation writes only data.",
      "Runtime flags, type, orders, and JS source are not opened by this contract.",
      "Turning the scenario on or off with scenario_active or in the SprutHub interface is not a configuration edit: get, restore, and deletion of a created BLOCK ignore active, and restore never sends it.",
      "Restore does not delete a created BLOCK or LOGIC that another BLOCK runs with a scenario target: the result is conflict scenario_targets_present naming those targets; change or remove them first, then restore again. After this scan the scenario is read again, and a change since the first read, including another scenario at the index, stops the delete (conflict).",
      "SprutHub exposes no native compare-and-set; pre-write comparison does not close the remaining race window.",
      "block_action_preview may name known enum values of a simple root equality condition beside each service/set. That is the condition domain at evaluation, not execution, order, physical effect, or a trigger change. Compound, nested, held, unknown, or inapplicable forms stay undisclosed and are not an empty domain. History does not refresh the saved coverage. block_action_preview.scenario_runs names the scenario each scenario target runs, switches or resets, with its mode.",
    ],
  };
}

export function scenarioRunContract() {
  return {
    version: "2026-09-24",
    write: "scenario.run({index})",
    scope: "one_active_BLOCK_or_user_LOGIC_scenario",
    required_configuration: { active: true },
    refused_until_live_check: {
      error: "scenario_run_unverified_type",
      types: "every type other than BLOCK and LOGIC, including GLOBAL",
      predefined: true,
    },
    preparation: "read_without_execution",
    effect: {
      targets:
        "literal service/set actions of a BLOCK that resolve to writable characteristics",
      targets_known:
        "false for LOGIC, and for BLOCK code anywhere, toggle/inc/dec actions, scenario targets, non-literal values, unresolved bindings, or uninterpreted nodes and fields",
      predicted:
        "true only for a BLOCK with known targets and no conditions, delays, or repeated targets; otherwise effect.reasons names what the hub decides during the run",
    },
    repeat:
      "one send per prepared change; prepare a new change for each explicit run",
    delivery: {
      not_sent:
        "transport confirmed that scenario.run was not sent; prepare a new change after recovery",
      acknowledged: "native scenario.run ACK received",
      rejected:
        "SprutHub returned an explicit rejection; its code remains available in command_delivery.rejection",
      unknown: "request may have run but ACK was lost; never retry this change",
      target_readback:
        "fresh values are reported separately and do not prove physical or atomic delivery",
    },
    restore_supported: false,
    evidence: {
      live_hub_version: "3.0.0b (20131)",
      live_run:
        "active action-only BLOCK with two Lightbulb On=false targets, including an explicit repeat run",
      turned_off_run:
        "a turned-off BLOCK: SprutHub acknowledged scenario.run and ran none of its actions; turned on, the same BLOCK ran (2026-09-24)",
      not_observed: [
        "a run of a turned-off LOGIC",
        "whether a run evaluates or bypasses BLOCK conditions and triggers",
        "delays and LOGIC",
        "GLOBAL, built-in, and other scenario types, which are refused",
      ],
    },
    limitations: [
      "GLOBAL, built-in (predefined), and other non-BLOCK, non-LOGIC scenarios are refused with scenario_run_unverified_type until a manual run is verified on a hub: a GLOBAL run may register its timers and subscriptions again. Ask the owner to run such a scenario in the SprutHub app.",
      "A turned-off scenario is refused: SprutHub acknowledges a run of a turned-off BLOCK but runs none of its actions. scenario_active turns it on and also re-arms its triggers.",
      "When effect.predicted is false, the hub decides what runs; listed targets are only the literal actions it may write. read_hub_log watch on this scenario, active during the run, shows what it did; the hub log kept no scenario lines without such a watch.",
      "Target readback cannot prove that this command caused an observed value or that physical devices acted atomically.",
      "SprutHub exposes no native compare-and-set; a race remains after the pre-run scenario check.",
    ],
  };
}

export function blockActionPauseContract() {
  return {
    version: "2026-09-12",
    write: "scenario.update({index,data})",
    scope: "one_existing_executable_BLOCK_action_selected_by_RFC_6901_pointer",
    duration: {
      unit: "seconds",
      minimum: 1,
      maximum: 31_536_000,
      starts: "first_apply",
    },
    native_mechanism:
      "if code-condition returning Date.now() >= one persisted absolute deadline",
    expiration:
      "the original action becomes eligible on the next ordinary trigger without a running client; missed triggers are not replayed",
    cleanup:
      "an unchanged owned expired controller is collapsed in the next planned write to the same BLOCK",
    restore:
      "remove_only_the_owned_unchanged_controller_and_keep_its_current_action",
    repeat:
      "the owned controller or its direct then/0 action replaces the same pause; overlapping narrower or wider scopes are rejected",
    evidence: {
      live_hub_version: "3.0.0b (20131)",
      code_condition_before_and_after_deadline: true,
      client_closed_between_evaluations: true,
      full_hub_restart: false,
    },
    limitations: [
      "Updating BLOCK data can cancel an already running native delay in that scenario.",
      "Expiration changes eligibility at the next trigger; it does not run the skipped action at the deadline.",
      "An inert expired controller may remain until the next ordinary write to this BLOCK.",
      "A selected subgraph containing trigger=true is rejected because nested trigger registration is not verified.",
      "Active/expired is estimated with the MCP host clock; SprutHub evaluates the deadline with the hub clock.",
      "SprutHub exposes no native compare-and-set; a race remains after the pre-write comparison.",
    ],
  };
}

export function characteristicContract(control, { requireWrite = true } = {}) {
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
  const scalarContract = nativeScalarContract(control, current.kind);
  const validValues = (control.validValues ?? []).flatMap((validValue) => {
    const typed = typedNativeValue(validValue?.value);
    if (typed.kind !== current.kind) {
      throw new SprutHubError(
        "unsupported_characteristic",
        "The selected characteristic has incompatible native valid values.",
      );
    }
    const projected = {
      key: validValue.key,
      name: validValue.name,
      ...typed,
    };
    return isSelectableNativeValidValue(validValue, typed, scalarContract)
      ? [projected]
      : [];
  });
  return {
    type: control.type,
    ...scalarContract,
    ...(control.validValues !== undefined ? { valid_values: validValues } : {}),
  };
}

export function logicAssignmentContract(target, type, assigned) {
  return {
    type: target.type,
    name:
      typeof type.name === "string"
        ? sanitizeNativeData(type.name)
        : target.type,
    description:
      typeof type.desc === "string" ? sanitizeNativeData(type.desc) : "",
    assigned,
    create_active: false,
    confirmation: "scoped_logic_list_and_configuration_readback",
  };
}

export function logicActiveContract() {
  return {
    type: "LogicActive",
    kind: "boolValue",
    confirmation: "separate_logic_get_readback",
  };
}

export function typedNativeValue(value) {
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

export function validateCharacteristicValue(value, contract) {
  refuseRedactionMark(value, "value");
  const validated = validateNativeScalarValue(value, contract);
  if (!validated.valid) {
    throw new SprutHubError("invalid_native_value", validated.message);
  }
  return validated.value;
}

export function valuesEqual(left, right) {
  return left?.kind === right?.kind && Object.is(left?.value, right?.value);
}

export function groupValuesEqual(left, right) {
  const numericKinds = new Set(["intValue", "longValue", "doubleValue"]);
  if (numericKinds.has(left?.kind) && numericKinds.has(right?.kind)) {
    return Object.is(Number(left.value), Number(right.value));
  }
  return valuesEqual(left, right);
}

export function roomNameLimits() {
  return {
    max_length: ROOM_NAME_MAX_LENGTH,
    length_unit: "unicode_code_points",
    refused_characters:
      "emoji and pictographs (Unicode Extended_Pictographic), variation selectors U+FE00-U+FE0F, and any character outside the Basic Multilingual Plane (U+10000 and above); only one emoji was seen dropped, the rest are refused as a precaution",
  };
}

export function logicSourceContract(mode) {
  return {
    version: "2026-10-13",
    scenario_type: "LOGIC",
    mode,
    source: {
      format: "javascript",
      execution_environment: "SprutHub scenario sandbox",
      exact_readback: true,
    },
    editable_fields:
      mode === "create"
        ? ["name", "description", "active", "on_start", "sync", "source"]
        : ["source"],
    // research/protocol/2026-10-13-wave4-contracts.md 1.5, 1.6.
    metadata_from_info:
      "SprutHub sets the scenario's name, description and start on boot from info.name, info.description and info.onStart in the code, at create (over the name, description and on_start sent) and again on every code write, even unchanged; sync is not in the code. They are changed only here: to rename a LOGIC, change its description or whether it runs when the hub starts, change that value in info as a plain value and leave the rest of the code as it is; window_option refuses them (logic_info_in_code) and changes only Sync. An update lists in code_sets each of them its write sets to another value than the scenario has ({field, from, to}), and in restore_code_sets each one its restore, which writes back the old code, sets to another value than the scenario had before the change ({field, before_change, to}), as a name given in the app that the old info does not hold; with a warning for a value set back from an unchanged info. A value info does not hold as a plain value (built from parts, changed or passed on after the literal) is listed with unknown: true. Code updates of one LOGIC are one chain: prepare each after the previous is applied and restore them newest first (restore_first_change_ref names the later one).",
    assignment: {
      mapping:
        "a created LOGIC's native type is the string of its scenario index (SprutHub 3.0.0); the selected service lists it in logic.types only while the LOGIC is on, named as the scenario, so logic_assignment_ready is true only then; with that service or its accessory removed it is false (logic_target_service_not_found), and restore works without it; an entry of that type named otherwise leaves the LOGIC unmapped (logic_type_name_mismatch), and so does a scenario at that index without this change's ownership marker (logic_scenario_not_owned): another LOGIC at a reused index, or this one with the marker removed from its source, which nothing tells apart; with no scenario at the index, or once the LOGIC was seen gone, nothing is mapped either (logic_scenario_not_found)",
      separate_operation: "logic_assignment",
    },
    restore: {
      update:
        "restore the exact saved source only while the observed applied source and metadata are unchanged",
      create:
        "delete only the owned unchanged scenario, on or off, when no assignment of its type is found across the home and no BLOCK runs it with a scenario target; what the scan finds blocks the delete (logic_assignments_present, scenario_targets_present); SprutHub 3.0.0 lists an assignment made while the LOGIC was on after it is turned off and does not assign a turned-off LOGIC, so the scan covers a turned-off LOGIC too; after the scan the scenario is read again, and a change since the first read, including another scenario at the index, stops the delete (conflict). An unmapped LOGIC (logic_type_name_mismatch, logic_scenario_not_owned) is not deleted",
      active:
        "turning the scenario on or off with scenario_active or in the SprutHub interface is not a change of source or metadata: restore never writes active and does not compare it with the snapshots, and restore of a create deletes a turned-off LOGIC as it does a turned-on one (see create)",
    },
    limitations: [
      "Source is stored and compared as exact text; it is not executed or statically analyzed locally.",
      "SprutHub-normalized create flags are reported separately and become the saved applied snapshot.",
      "A successful source readback does not confirm callback behavior or physical effects.",
      "SprutHub exposes no compare-and-set; a race remains after the pre-write comparison.",
    ],
  };
}
