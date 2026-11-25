import { valuesEqual } from "./change-contracts.mjs";
import {
  parseWindowRef,
  REDACTED_MARK,
  writeRejection,
} from "./change-refs.mjs";
import { CODE_DEPENDENCY_NOTE } from "./code-device-refs.mjs";
import {
  extractButtonPayload,
  isAllowedTelegramTextOption,
  isAllowedWindowButtonWindowKey,
  isZigbeeCoordinatorWindow,
  matchAllowedWindowButton,
  scalarEnvelope,
  THERMOSTAT_VALVE_CALIBRATION_PATTERN,
  THERMOSTAT_VALVE_CALIBRATION_STATUS_PATTERN,
} from "./native-option-contract.mjs";
import {
  isSensitiveNativeNode,
  SprutHubError,
  sanitizeNativeData,
} from "./spruthub-client.mjs";

export const WINDOW_BUTTON = "window_button";

export function buttonWireValue(payload) {
  return { [payload.kind]: payload.value };
}

export async function getWindowButtonContract(client, input, hubSerial) {
  if (input.target_ref === undefined && input.option_key === undefined) {
    return {
      status: "ok",
      operation: WINDOW_BUTTON,
      contract: windowButtonContract(),
      restore_supported: false,
    };
  }
  if (
    input.target_ref !== undefined &&
    (typeof input.option_key !== "string" || input.option_key.length === 0)
  ) {
    const { windowKey } = parseWindowRef(input.target_ref, hubSerial);
    if (!isAllowedWindowButtonWindowKey(windowKey)) {
      throw unsupportedWindowButton();
    }
    return {
      status: "ok",
      operation: WINDOW_BUTTON,
      target_ref: input.target_ref,
      contract: windowButtonContract(),
      restore_supported: false,
    };
  }
  const inspected = await inspectWindowButton(
    client,
    input.target_ref,
    input.option_key,
    hubSerial,
  );
  return {
    status: "ok",
    operation: WINDOW_BUTTON,
    target_ref: input.target_ref,
    option_key: input.option_key,
    contract: windowButtonContract(inspected),
    restore_supported: false,
  };
}

export function telegramTextContractFields(windowKey, optionKey) {
  if (!isAllowedTelegramTextOption(windowKey, optionKey)) return {};
  if (optionKey === "BotApiUrl") {
    return {
      allowed_format:
        "empty string or absolute http:// or https:// URL without whitespace, control characters, or embedded credentials",
    };
  }
  if (optionKey === "ProxyPort") {
    return {
      allowed_format: "empty string or TCP port integer string from 1 to 65535",
    };
  }
  if (optionKey === "ProxyHost") {
    return {
      allowed_format:
        "empty string or plain host name or IP address without whitespace, control characters, URL syntax, or credentials",
    };
  }
  if (optionKey === "Name") {
    return {
      allowed_format:
        "non-empty plain display name without control characters or credentials",
    };
  }
  return {};
}

function hasAsciiControlChar(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function validateTelegramTextOptionValue(windowKey, optionKey, value) {
  if (!isAllowedTelegramTextOption(windowKey, optionKey)) return;
  if (typeof value !== "string") return;
  if (optionKey === "BotApiUrl") {
    if (value === "") return;
    if (hasAsciiControlChar(value) || /\s/.test(value)) {
      throw new SprutHubError(
        "invalid_native_value",
        "BotApiUrl must be an empty string or a valid http:// or https:// URL without whitespace, control characters, or embedded credentials.",
      );
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new SprutHubError(
        "invalid_native_value",
        "BotApiUrl must be an empty string or a valid http:// or https:// URL without embedded credentials.",
      );
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.hostname.length === 0
    ) {
      throw new SprutHubError(
        "invalid_native_value",
        "BotApiUrl must use http:// or https:// with a valid host.",
      );
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new SprutHubError(
        "invalid_native_value",
        "BotApiUrl must not contain an embedded username or password.",
      );
    }
    if (
      sanitizeNativeData(value) !== value ||
      sanitizeNativeData(parsed.href) !== parsed.href
    ) {
      throw new SprutHubError(
        "invalid_native_value",
        "BotApiUrl must not contain embedded credentials or tokens.",
      );
    }
    return;
  }
  if (optionKey === "ProxyPort") {
    if (value === "") return;
    if (
      !/^[1-9]\d{0,4}$/.test(value) ||
      Number(value) < 1 ||
      Number(value) > 65_535
    ) {
      throw new SprutHubError(
        "invalid_native_value",
        "ProxyPort must be an empty string or a TCP port integer string from 1 to 65535.",
      );
    }
    return;
  }
  if (optionKey === "ProxyHost") {
    if (value === "") return;
    if (
      hasAsciiControlChar(value) ||
      /\s/.test(value) ||
      /[/@?#]/.test(value) ||
      sanitizeNativeData(value) !== value
    ) {
      throw new SprutHubError(
        "invalid_native_value",
        "ProxyHost must be an empty string or a plain host name or IP address without whitespace, control characters, URL syntax, or credentials.",
      );
    }
    return;
  }
  if (optionKey === "Name") {
    if (value.trim().length === 0 || hasAsciiControlChar(value)) {
      throw new SprutHubError(
        "invalid_native_value",
        "Name must be a non-empty plain display name without control characters.",
      );
    }
    if (sanitizeNativeData(value) !== value) {
      throw new SprutHubError(
        "invalid_native_value",
        "Name must not contain credentials, tokens, or secret-shaped text.",
      );
    }
  }
}

export function windowButtonContract(inspected = null) {
  return {
    write: "window.update({windowKey, options: [{key, value}]})",
    fields: {
      target_ref: "window ref from get_entity",
      option_key:
        "allowlisted BUTTON/BUTTON_DANGER key from physical_configuration.commands",
      reason: "why the owner asked",
      value: "omit; button payload comes from the hub option",
    },
    ...(inspected
      ? {
          button: {
            key: inspected.optionKey,
            name: inspected.buttonName,
            kind: inspected.rule.id,
            requires_confirmation: inspected.requiresConfirmation,
          },
        }
      : {}),
    allowlist: {
      telegram: {
        window: "Notification/telegram_<id>/",
        buttons: {
          Login: "requires non-empty Token on hub; no confirmation prompt",
          Logout:
            "always sets tell_owner confirmation; stops Telegram notifications until logged in again",
        },
      },
      thermostat_valve_calibration: {
        window: "Controller/zigbee_<id>/Child/<child>/",
        buttons:
          "/<ep>/<cluster>_<name>/<attr>_ThermostatValveCalibration/<arg>",
      },
      physical_device_remove: {
        window: "Controller/(zigbee|xiaomi)_<id>/Child/<child>/",
        buttons: {
          Remove:
            "BUTTON_DANGER; audits linked accessories and dependencies (BLOCK, code/id lists, links, bridges, logics), always returns tell_owner for one owner confirmation, refuses ZigBee coordinator (short address 0000); requires physical re-pairing to bring back",
        },
      },
    },
    repeat:
      "one send per prepared change; prepare a new change for each explicit button press",
    delivery: {
      not_sent: "transport confirmed nothing was sent; prepare again",
      acknowledged: "native window.update ACK received; effect read back",
      rejected: "SprutHub returned an explicit error; never resent",
      unknown: "ACK lost; marked uncertain (hub_effect=unknown), never resent",
    },
    restore_supported: false,
    limitations: [
      "Only allowlisted buttons are pressed; extension-level Remove, DeleteAllAccessories, debug, and hub-settings buttons are refused.",
      "Button presses cannot be undone with restore_native_change.",
      "An unknown outcome after a lost reply is never resent automatically; check get_native_change first.",
    ],
  };
}

export async function inspectWindowButton(
  client,
  targetRef,
  optionKey,
  hubSerial,
) {
  const { windowKey } = parseWindowRef(targetRef, hubSerial);
  if (typeof optionKey !== "string" || optionKey.length === 0) {
    throw new SprutHubError(
      "option_key_required",
      "Select one window button option_key before reading its contract or preparing a button press.",
      "get_entity",
    );
  }
  if (!isAllowedWindowButtonWindowKey(windowKey)) {
    throw unsupportedWindowButton();
  }
  const window = await client.getWindow(windowKey);
  const rule = matchAllowedWindowButton(windowKey, optionKey);
  if (
    rule?.id === "physical_device_remove" &&
    isZigbeeCoordinatorWindow(window)
  ) {
    throw zigbeeCoordinatorProtected();
  }
  const matches = window.options.filter(({ key }) => key === optionKey);
  if (matches.length !== 1) {
    throw new SprutHubError(
      matches.length === 0
        ? "window_button_not_found"
        : "incompatible_response",
      matches.length === 0
        ? "The selected window button was not found."
        : "SprutHub returned the selected window button more than once.",
      "get_entity",
    );
  }
  const option = matches[0];
  if (isSensitiveNativeNode(option)) {
    throw new SprutHubError(
      "sensitive_native_data",
      "The selected window control contains sensitive native data.",
      "get_entity",
    );
  }
  if (!rule || option.inputType !== rule.inputType) {
    throw unsupportedWindowButton();
  }
  if (option.visible === false) {
    throw new SprutHubError(
      "window_button_hidden",
      "The selected window button is currently hidden in SprutHub (for example, Telegram Login is hidden while already logged in and Logout is hidden while logged out).",
      "get_entity",
    );
  }
  if (option.disabled === true) {
    throw new SprutHubError(
      "window_button_disabled",
      "The selected window button is currently disabled in SprutHub.",
      "get_entity",
    );
  }
  if (option.write !== true) {
    throw new SprutHubError(
      "insufficient_rights",
      "The selected window button is not writable.",
      "get_entity",
    );
  }
  const payload = extractButtonPayload(option);
  if (!payload) {
    throw new SprutHubError(
      "incompatible_response",
      "The selected window button has no supported scalar button payload.",
      "get_entity",
    );
  }
  if (rule.requiresTelegramToken && !hasNonEmptyTelegramToken(window)) {
    throw new SprutHubError(
      "telegram_token_missing",
      "Telegram bot token is missing or empty in SprutHub. Ask the owner to enter the bot token in the SprutHub app first, then try logging in again.",
      "ask_owner",
    );
  }
  const hasNativeConfirm =
    Array.isArray(option.validValues) &&
    option.validValues.some(
      ({ confirm }) => typeof confirm === "string" && confirm.length > 0,
    );
  const buttonName =
    typeof option.name === "string" && option.name.trim().length > 0
      ? sanitizeNativeData(option.name)
      : optionKey;
  const windowName =
    typeof window.label?.text === "string" &&
    window.label.text.trim().length > 0
      ? sanitizeNativeData(window.label.text)
      : null;
  return {
    window,
    windowKey,
    windowName,
    optionKey,
    rule,
    payload,
    buttonName,
    targetName: windowName ? `${windowName} / ${buttonName}` : buttonName,
    requiresConfirmation: rule.requiresConfirmation || hasNativeConfirm,
    extensionKey: rule.extensionKey,
    childId: rule.childId,
  };
}

export async function reverifyWindowButtonBeforeApply(client, change) {
  let window;
  if (change.button_kind === "physical_device_remove") {
    try {
      window = await client.nativeWindow(
        client.selectedSerial(),
        change.target.windowKey,
        Date.now() + client.timeoutMs,
      );
    } catch (error) {
      if (
        error instanceof SprutHubError &&
        (error.code === "request_rejected" || error.code === "not_found")
      ) {
        return { ok: false, conflict_reason: "window_button_not_found" };
      }
      throw error;
    }
    if (window === null) {
      return { ok: false, conflict_reason: "window_button_not_found" };
    }
    if (isZigbeeCoordinatorWindow(window)) {
      throw zigbeeCoordinatorProtected();
    }
  } else {
    window = await client.getWindow(change.target.windowKey);
  }
  const matches = window.options.filter(({ key }) => key === change.option_key);
  if (matches.length === 0) {
    return { ok: false, conflict_reason: "window_button_not_found" };
  }
  if (matches.length > 1) {
    return { ok: false, conflict_reason: "window_button_changed" };
  }
  const option = matches[0];
  if (isSensitiveNativeNode(option)) {
    throw new SprutHubError(
      "sensitive_native_data",
      "The selected window control contains sensitive native data.",
      "get_entity",
    );
  }
  const rule = matchAllowedWindowButton(
    change.target.windowKey,
    change.option_key,
  );
  if (
    !rule ||
    rule.id !== change.button_kind ||
    option.inputType !== rule.inputType
  ) {
    return { ok: false, conflict_reason: "window_button_changed" };
  }
  if (option.visible === false) {
    return { ok: false, conflict_reason: "window_button_hidden" };
  }
  if (option.disabled === true) {
    return { ok: false, conflict_reason: "window_button_disabled" };
  }
  if (option.write !== true) {
    return { ok: false, conflict_reason: "window_button_not_writable" };
  }
  const payload = extractButtonPayload(option);
  if (!payload || !valuesEqual(payload, change.payload)) {
    return { ok: false, conflict_reason: "window_button_changed" };
  }
  if (rule.requiresTelegramToken && !hasNonEmptyTelegramToken(window)) {
    return { ok: false, conflict_reason: "telegram_token_missing" };
  }
  return { ok: true, window };
}

export function windowButtonTellOwner(inspected) {
  if (inspected.rule.id === "telegram_logout") {
    return "Logging out stops Telegram notifications and clears the active bot session until logged in again. Confirm with the owner before calling apply_native_change.";
  }
  if (inspected.requiresConfirmation) {
    return "This window button requires explicit owner confirmation before calling apply_native_change.";
  }
  return undefined;
}

export function classifyWindowButtonDelivery(error) {
  if (error instanceof SprutHubError && error.requestSent === false) {
    error.action = "restore_connection_then_prepare_native_change";
    return { status: "not_sent", failure: deliveryFailure(error) };
  }
  if (writeRejection(error)) {
    return { status: "rejected", rejection: deliveryFailure(error) };
  }
  return { status: "unknown" };
}

export async function observeWindowButtonEffect(client, change) {
  const checkedAt = new Date().toISOString();
  if (
    change.button_kind === "telegram_login" ||
    change.button_kind === "telegram_logout"
  ) {
    let extension = null;
    let extensionError = null;
    if (typeof change.extension_key === "string") {
      try {
        const result = await client.nativeExtension(
          client.selectedSerial(),
          change.extension_key,
          Date.now() + client.timeoutMs,
        );
        extension = result.extension;
      } catch (error) {
        extensionError = readbackErrorSummary(error);
      }
    }
    let window = null;
    let windowError = null;
    try {
      window = await client.getWindow(change.target.windowKey);
    } catch (error) {
      windowError = readbackErrorSummary(error);
    }
    const observedEffect = {
      extension_state:
        extension && typeof extension.state === "string"
          ? sanitizeNativeData(extension.state)
          : null,
      enabled:
        extension && typeof extension.enabled === "boolean"
          ? extension.enabled
          : null,
      window_error:
        window &&
        typeof window.label?.error === "string" &&
        window.label.error.trim().length > 0
          ? sanitizeNativeData(window.label.error)
          : null,
      login_visible: window ? buttonVisibility(window, "Login") : null,
      logout_visible: window ? buttonVisibility(window, "Logout") : null,
    };
    const readbackError =
      extensionError || windowError
        ? {
            ...(extensionError ? { extension: extensionError } : {}),
            ...(windowError ? { window: windowError } : {}),
          }
        : undefined;
    const verification = readbackError
      ? {
          checked_at: checkedAt,
          fresh: false,
          result: "readback_incomplete",
          error: extensionError?.code ?? windowError?.code ?? "readback_failed",
        }
      : {
          checked_at: checkedAt,
          fresh: true,
          result: "telegram_effect_observed",
        };
    return { observedEffect, readbackError, verification };
  }

  if (change.button_kind === "physical_device_remove") {
    let windowAbsent = null;
    let windowError = null;
    try {
      const window = await client.nativeWindow(
        client.selectedSerial(),
        change.target.windowKey,
        Date.now() + client.timeoutMs,
      );
      windowAbsent = window === null;
    } catch (error) {
      if (
        error instanceof SprutHubError &&
        (error.code === "request_rejected" || error.code === "not_found")
      ) {
        // Live temp-scenario probe on SprutHub 3.0.0 rev 20131 (25.11.2026)
        // returned request_rejected on window.get after Remove.
        windowAbsent = true;
      } else {
        windowError = readbackErrorSummary(error);
      }
    }

    let childAbsent = null;
    let childError = null;
    const childId = change.device_remove?.child_id;
    if (
      typeof change.extension_key === "string" &&
      typeof childId === "string"
    ) {
      try {
        const { children } = await client.nativeExtensionChildren(
          client.selectedSerial(),
          change.extension_key,
          Date.now() + client.timeoutMs,
        );
        childAbsent = !children.some((entry) => entry.id === childId);
      } catch (error) {
        childError = readbackErrorSummary(error);
      }
    }

    const accessoriesAbsent = [];
    const accessoriesRemaining = [];
    const accessoryErrors = [];
    const homeRef = change.home_ref;
    for (const id of change.device_remove_baseline?.linked_accessory_ids ??
      []) {
      const ref = `${homeRef}/accessory/${id}`;
      try {
        const accessory = await client.getAccessoryOrNull(id);
        if (accessory === null) {
          accessoriesAbsent.push(ref);
        } else {
          accessoriesRemaining.push(ref);
        }
      } catch (error) {
        accessoryErrors.push({ ref, ...readbackErrorSummary(error) });
      }
    }

    const observedEffect = {
      window_absent: windowAbsent,
      child_absent: childAbsent,
      accessories_absent: accessoriesAbsent,
      accessories_remaining: accessoriesRemaining,
    };
    const readbackError =
      windowError || childError || accessoryErrors.length > 0
        ? {
            ...(windowError ? { window: windowError } : {}),
            ...(childError ? { extension_children: childError } : {}),
            ...(accessoryErrors.length > 0
              ? { accessories: accessoryErrors }
              : {}),
          }
        : undefined;
    const verification = readbackError
      ? {
          checked_at: checkedAt,
          fresh: false,
          result: "readback_incomplete",
          error:
            windowError?.code ??
            childError?.code ??
            accessoryErrors[0]?.code ??
            "readback_failed",
        }
      : {
          checked_at: checkedAt,
          fresh: true,
          result:
            windowAbsent === true &&
            childAbsent !== false &&
            accessoriesRemaining.length === 0
              ? "device_removal_observed"
              : windowAbsent === true ||
                  childAbsent === true ||
                  accessoriesAbsent.length > 0
                ? "device_removal_partial"
                : "device_still_present",
        };
    return { observedEffect, readbackError, verification };
  }

  // Thermostat valve calibration readback.
  let window = null;
  let windowError = null;
  try {
    window = await client.getWindow(change.target.windowKey);
  } catch (error) {
    windowError = readbackErrorSummary(error);
  }
  const calibrationStatus = window
    ? readCalibrationStatus(window, change.option_key)
    : null;
  const readbackError = windowError ? { window: windowError } : undefined;
  const verification = readbackError
    ? {
        checked_at: checkedAt,
        fresh: false,
        result: "readback_incomplete",
        error: windowError.code,
      }
    : {
        checked_at: checkedAt,
        fresh: true,
        result: "calibration_status_observed",
      };
  return {
    observedEffect: { calibration_status: calibrationStatus },
    readbackError,
    verification,
  };
}

export function publicWindowButtonChange(change, { verification } = {}) {
  const effectiveVerification =
    verification !== undefined ? verification : change.last_verification;
  const isCalibration = change.button_kind === "thermostat_valve_calibration";
  const isDeviceRemove = change.button_kind === "physical_device_remove";
  const isUncertain = change.status === "uncertain";
  return {
    status: change.status,
    change_ref: `spruthub-change://native/${change.id}`,
    operation: WINDOW_BUTTON,
    reason: change.reason,
    target_ref: change.target_ref,
    option_key: change.option_key,
    button: {
      key: change.option_key,
      name: change.button_name,
      kind: change.button_kind,
      requires_confirmation: change.requires_confirmation === true,
    },
    ...(change.device_remove
      ? { device_remove: structuredClone(change.device_remove) }
      : {}),
    native_write_sent: change.native_write_sent,
    native_acknowledged: change.native_acknowledged,
    ...(isUncertain ? { hub_effect: "unknown" } : {}),
    command_delivery: {
      ...structuredClone(change.button_delivery),
      native_acknowledged: change.native_acknowledged === true,
    },
    ...(change.write_intent
      ? { write_intent: structuredClone(change.write_intent) }
      : {}),
    ...(change.observed_effect
      ? { observed_effect: structuredClone(change.observed_effect) }
      : {}),
    ...(change.readback_error
      ? { readback_error: structuredClone(change.readback_error) }
      : {}),
    ...(effectiveVerification ? { verification: effectiveVerification } : {}),
    ...(change.conflict_reason
      ? { conflict_reason: change.conflict_reason }
      : {}),
    restore_supported: false,
    limitations: [
      "Preparation and read-only inspection do not press the button.",
      ...(isDeviceRemove
        ? [
            "Removing a physical device cannot be undone automatically with restore_native_change; bringing it back requires physical re-pairing.",
            "Live SprutHub response and events for removing a physical ZigBee or Xiaomi child have not yet been observed on a live hub (only the Remove button wire format was observed live on a temporary scenario on 25.11.2026).",
            "Scenarios and code still mentioning removed accessory IDs remain on the hub and will no longer reach the device.",
            CODE_DEPENDENCY_NOTE,
          ]
        : [
            "A window button press cannot be undone automatically with restore_native_change.",
            ...(isCalibration
              ? [
                  "Valve calibration runs physically on the thermostat valve after SprutHub acknowledges the button press; window readback only reflects what the hub currently reports and does not prove mechanical calibration completed.",
                ]
              : [
                  "An acknowledged Telegram Login or Logout button press triggers asynchronous hub state changes; observed_effect reflects the subsequent readback and may still be settling.",
                ]),
          ]),
      ...readbackErrorLimitation(change),
      "An unknown outcome after a lost reply is never resent automatically; check get_native_change before preparing a new press.",
    ],
  };
}

function readbackErrorLimitation(change) {
  if (!change.readback_error) return [];
  if (change.native_acknowledged === true) {
    return [
      "SprutHub acknowledged the button press, but post-ACK readback failed or was incomplete (see readback_error). Do not assume nothing was sent; check get_native_change to refresh observed_effect.",
    ];
  }
  if (
    change.native_write_sent === true &&
    (change.status === "uncertain" || change.status === "applying")
  ) {
    return [
      "The button press was sent without a confirmed hub reply, and reading back the current state also failed or was incomplete (see readback_error). The hub effect is unknown; check get_native_change later instead of blindly resending.",
    ];
  }
  return [
    "Refreshing the current window or extension state failed or was incomplete (see readback_error). This read did not send or acknowledge a button press; check get_native_change again later.",
  ];
}

export function zigbeeCoordinatorProtected() {
  return new SprutHubError(
    "zigbee_coordinator_protected",
    "This ZigBee child is the ZigBee network coordinator (short address 0000) and cannot be removed. Removing the coordinator would break the ZigBee network. Nothing was written.",
    "get_entity",
  );
}

function unsupportedWindowButton() {
  return new SprutHubError(
    "unsupported_window_button",
    "Only allowlisted window buttons (Telegram Login/Logout, ZigBee thermostat valve calibration, and ZigBee/Xiaomi controller child Remove) are supported; extension-level Remove, destructive hub/controller buttons, debug buttons, and other window buttons are refused.",
    "get_entity",
  );
}

function hasNonEmptyTelegramToken(window) {
  const tokenOption = window.options.find(({ key }) => key === "Token");
  return (
    typeof tokenOption?.value?.stringValue === "string" &&
    tokenOption.value.stringValue.trim().length > 0 &&
    !tokenOption.value.stringValue.includes(REDACTED_MARK)
  );
}

function buttonVisibility(window, key) {
  const option = window.options.find((entry) => entry.key === key);
  return option ? option.visible !== false : null;
}

function readCalibrationStatus(window, buttonKey) {
  const buttonMatch = THERMOSTAT_VALVE_CALIBRATION_PATTERN.exec(buttonKey);
  const prefix = buttonMatch?.[1] ?? "";
  const statusOption =
    window.options.find(
      (option) =>
        prefix.length > 0 &&
        option.key.startsWith(prefix) &&
        THERMOSTAT_VALVE_CALIBRATION_STATUS_PATTERN.test(option.key),
    ) ??
    window.options.find((option) =>
      THERMOSTAT_VALVE_CALIBRATION_STATUS_PATTERN.test(option.key),
    );
  if (!statusOption || isSensitiveNativeNode(statusOption)) return null;
  const typed = scalarEnvelope(statusOption.value);
  if (!typed) return null;
  let label = null;
  if (Array.isArray(statusOption.validValues)) {
    const matched = statusOption.validValues.find((candidate) => {
      const candidateTyped = scalarEnvelope(candidate?.value);
      return candidateTyped && valuesEqual(candidateTyped, typed);
    });
    if (typeof matched?.name === "string" && matched.name.length > 0) {
      label = sanitizeNativeData(matched.name);
    }
  }
  return {
    value: sanitizeNativeData(typed.value),
    label,
  };
}

function deliveryFailure(error) {
  return {
    code: error.code,
    ...(error.protocolErrorCode !== undefined
      ? { protocol_code: error.protocolErrorCode }
      : {}),
    ...(error.action ? { action: error.action } : {}),
  };
}

function readbackErrorSummary(error) {
  if (error instanceof SprutHubError) {
    return {
      code: error.code,
      message: sanitizeNativeData(error.message),
    };
  }
  return {
    code: "readback_failed",
    message: "Post-write readback failed.",
  };
}
