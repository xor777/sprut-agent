const numericKinds = new Set(["intValue", "longValue", "doubleValue"]);
const scalarKinds = new Set([
  "boolValue",
  "intValue",
  "longValue",
  "doubleValue",
  "stringValue",
]);
const genericKindByType = new Map([
  ["GenericBoolean", "boolValue"],
  ["GenericInteger", "intValue"],
  ["GenericLong", "longValue"],
  ["GenericDouble", "doubleValue"],
  ["GenericString", "stringValue"],
]);

export const TELEGRAM_WINDOW_KEY_PATTERN = /^Notification\/(telegram_[^/]+)\/$/;
export const TELEGRAM_SAFE_TEXT_KEYS = new Set([
  "BotApiUrl",
  "ProxyHost",
  "ProxyPort",
  "Name",
]);
export const ZIGBEE_CHILD_WINDOW_KEY_PATTERN =
  /^Controller\/zigbee_[^/]+\/Child\/[^/]+\/$/;
export const CONTROLLER_CHILD_WINDOW_KEY_PATTERN =
  /^Controller\/((?:zigbee|xiaomi)_[^/]+)\/Child\/([^/]+)\/$/;
export const THERMOSTAT_VALVE_CALIBRATION_PATTERN =
  /^(\/\d+\/[0-9A-Fa-f]+_[^/]+\/)[0-9A-Fa-f]+_ThermostatValveCalibration\/[^/]+$/;
export const THERMOSTAT_VALVE_CALIBRATION_STATUS_PATTERN =
  /^(\/\d+\/[0-9A-Fa-f]+_[^/]+\/)[0-9A-Fa-f]+_ThermostatValveCalibrationStatus\/[^/]+$/;
const HTML_LINE_BREAK_PATTERN = /<br\s*\/?>|<\/?(?:p|div|li|tr)\b[^>]*>/gi;
const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/gi;
const ZIGBEE_COORDINATOR_ADDRESS_PATTERN =
  /(?:^|\r?\n)\s*Address\s*:\s*[^\s/\r\n]+\s*\/\s*(?:0x)?0000(?:\b|$)/i;
const BUTTON_INPUT_TYPES = new Set(["BUTTON", "BUTTON_DANGER"]);

function normalizeHtmlInfoText(text) {
  return text
    .replace(HTML_LINE_BREAK_PATTERN, "\n")
    .replace(HTML_TAG_PATTERN, "")
    .replace(/&nbsp;/gi, " ");
}

export function isTelegramWindowKey(windowKey) {
  return (
    typeof windowKey === "string" && TELEGRAM_WINDOW_KEY_PATTERN.test(windowKey)
  );
}

export function telegramExtensionKeyFromWindowKey(windowKey) {
  if (typeof windowKey !== "string") return null;
  const match = TELEGRAM_WINDOW_KEY_PATTERN.exec(windowKey);
  return match ? `Notification:${match[1]}` : null;
}

export function parseControllerChildWindowKey(windowKey) {
  if (typeof windowKey !== "string") return null;
  const match = CONTROLLER_CHILD_WINDOW_KEY_PATTERN.exec(windowKey);
  if (!match) return null;
  return {
    extensionKey: `Controller:${match[1]}`,
    childId: match[2],
  };
}

// On SprutHub, the ZigBee coordinator appears as a normal ZigBee child window
// with a visible Remove button, identified by short network address 0x0000 in
// its Info HTML ("Address: <ieee>/0000<br>...").
export function isZigbeeCoordinatorWindow(window) {
  if (
    !window ||
    typeof window !== "object" ||
    !ZIGBEE_CHILD_WINDOW_KEY_PATTERN.test(window.windowKey) ||
    !Array.isArray(window.options)
  ) {
    return false;
  }
  return window.options.some((option) => {
    if (
      !option ||
      typeof option !== "object" ||
      (option.key !== "Info" && option.inputType !== "HTML")
    ) {
      return false;
    }
    const text = option.value?.stringValue;
    return (
      typeof text === "string" &&
      ZIGBEE_COORDINATOR_ADDRESS_PATTERN.test(normalizeHtmlInfoText(text))
    );
  });
}

export function isAllowedTelegramTextOption(windowKey, optionKey) {
  return (
    isTelegramWindowKey(windowKey) && TELEGRAM_SAFE_TEXT_KEYS.has(optionKey)
  );
}

export function isAllowedWindowButtonWindowKey(windowKey) {
  return (
    typeof windowKey === "string" &&
    (TELEGRAM_WINDOW_KEY_PATTERN.test(windowKey) ||
      CONTROLLER_CHILD_WINDOW_KEY_PATTERN.test(windowKey))
  );
}

export function matchAllowedWindowButton(windowKey, optionKey) {
  if (typeof windowKey !== "string" || typeof optionKey !== "string") {
    return null;
  }
  const telegram = TELEGRAM_WINDOW_KEY_PATTERN.exec(windowKey);
  if (telegram) {
    if (optionKey === "Login") {
      return {
        id: "telegram_login",
        inputType: "BUTTON",
        requiresConfirmation: false,
        requiresTelegramToken: true,
        extensionKey: `Notification:${telegram[1]}`,
        childId: null,
      };
    }
    if (optionKey === "Logout") {
      return {
        id: "telegram_logout",
        inputType: "BUTTON",
        requiresConfirmation: true,
        requiresTelegramToken: false,
        extensionKey: `Notification:${telegram[1]}`,
        childId: null,
      };
    }
    return null;
  }
  const controllerChild = parseControllerChildWindowKey(windowKey);
  if (controllerChild) {
    if (
      ZIGBEE_CHILD_WINDOW_KEY_PATTERN.test(windowKey) &&
      THERMOSTAT_VALVE_CALIBRATION_PATTERN.test(optionKey)
    ) {
      return {
        id: "thermostat_valve_calibration",
        inputType: "BUTTON",
        requiresConfirmation: false,
        requiresTelegramToken: false,
        extensionKey: null,
        childId: null,
      };
    }
    if (optionKey === "Remove") {
      return {
        id: "physical_device_remove",
        inputType: "BUTTON_DANGER",
        requiresConfirmation: true,
        requiresTelegramToken: false,
        extensionKey: controllerChild.extensionKey,
        childId: controllerChild.childId,
      };
    }
  }
  return null;
}

// Live wire contract (SprutHub 3.0.0 rev 20131): pressing a single BUTTON or
// BUTTON_DANGER sends its current typed scalar envelope when read=true (C1), or
// validValues[0].value when write=true && read!==true and validValues has length 1 (C3).
export function extractButtonPayload(option) {
  if (
    !option ||
    typeof option !== "object" ||
    !BUTTON_INPUT_TYPES.has(option.inputType)
  ) {
    return null;
  }
  if (option.read === true) {
    if (Array.isArray(option.validValues) && option.validValues.length > 1) {
      return null;
    }
    const typed = scalarEnvelope(option.value);
    return typed && scalarValueMatchesKind(typed.value, typed.kind)
      ? typed
      : null;
  }
  if (option.write === true) {
    if (!Array.isArray(option.validValues) || option.validValues.length !== 1) {
      return null;
    }
    const typed = scalarEnvelope(option.validValues[0]?.value);
    return typed && scalarValueMatchesKind(typed.value, typed.kind)
      ? typed
      : null;
  }
  return null;
}

export function publicWindowButtonNativeChange(windowKey, option, window) {
  const rule = matchAllowedWindowButton(windowKey, option?.key);
  if (
    !rule ||
    option.inputType !== rule.inputType ||
    (rule.id === "physical_device_remove" &&
      isZigbeeCoordinatorWindow(window)) ||
    option.visible === false ||
    option.disabled === true ||
    option.write !== true ||
    !extractButtonPayload(option)
  ) {
    return undefined;
  }
  const hasNativeConfirm =
    Array.isArray(option.validValues) &&
    option.validValues.some(
      ({ confirm }) => typeof confirm === "string" && confirm.length > 0,
    );
  const requiresConfirmation = rule.requiresConfirmation || hasNativeConfirm;
  return {
    native_write: true,
    supported: true,
    operation: "window_button",
    ...(requiresConfirmation ? { requires_confirmation: true } : {}),
  };
}

export function inspectNativeOption(
  option,
  { requireWrite = true, allowText = false, allowListedText = false } = {},
) {
  if (!option || typeof option !== "object" || Array.isArray(option)) {
    return incompatible(
      "invalid_option",
      "SprutHub returned an invalid option.",
    );
  }
  if (requireWrite && option.visible === false) {
    return hidden(
      "option_hidden",
      "The selected setting is currently hidden in SprutHub.",
    );
  }
  if (typeof option.type !== "string" || option.type.length === 0) {
    return unsupported(
      "missing_native_type",
      "The selected setting has no stable native type.",
    );
  }
  if (option.read !== true) {
    return rights("not_readable", "The selected setting is not readable.");
  }
  if (requireWrite && option.write !== true) {
    return rights("read_only", "The selected setting is not writable.");
  }
  if (option.disabled === true) {
    return rights("disabled", "The selected setting is disabled.");
  }

  const current = scalarEnvelope(option.value);
  if (!current) {
    return unsupported(
      "unsupported_value_envelope",
      "The selected setting has no supported scalar value envelope.",
    );
  }
  if (!scalarValueMatchesKind(current.value, current.kind)) {
    return incompatible(
      "invalid_current_value",
      "SprutHub returned a value that does not match its native envelope.",
    );
  }
  const declaredKind = genericKindByType.get(option.type);
  if (declaredKind && declaredKind !== current.kind) {
    return unsupported(
      "incompatible_native_type",
      "The selected setting value does not match its declared native type.",
    );
  }

  const inputType = option.inputType;
  const hasNonEmptyValidValues =
    Array.isArray(option.validValues) && option.validValues.length > 0;
  if (inputType === "NUMBER") {
    if (!numericKinds.has(current.kind)) {
      return unsupported(
        "incompatible_input_value",
        "A NUMBER setting must use intValue, longValue, or doubleValue.",
      );
    }
  } else if (inputType === "CHECKBOX") {
    if (current.kind !== "boolValue") {
      return unsupported(
        "incompatible_input_value",
        "A CHECKBOX setting must use boolValue.",
      );
    }
  } else if (
    (inputType === "TEXT" &&
      (allowText || (allowListedText && hasNonEmptyValidValues))) ||
    (allowText && inputType === "TEXT_MULTILINE")
  ) {
    if (current.kind !== "stringValue") {
      return unsupported(
        "incompatible_input_value",
        "A TEXT setting must use stringValue.",
      );
    }
    if (
      option.validValues !== undefined &&
      !Array.isArray(option.validValues)
    ) {
      return incompatible(
        "incompatible_valid_values",
        "SprutHub returned invalid native valid values.",
      );
    }
  } else if (inputType !== "LIST") {
    return unsupported(
      "unsupported_input_type",
      "Only NUMBER, CHECKBOX, and LIST settings are supported.",
    );
  }

  const numericMetadata = inspectNumericMetadata(option, current);
  if (!numericMetadata.supported) return numericMetadata;
  const lengthMetadata = inspectLengthMetadata(option, current);
  if (!lengthMetadata.supported) return lengthMetadata;

  let validValues;
  if (
    inputType === "LIST" ||
    (inputType === "TEXT" && hasNonEmptyValidValues)
  ) {
    if (!Array.isArray(option.validValues) || option.validValues.length === 0) {
      return unsupported(
        "missing_valid_values",
        "A LIST setting requires explicit native valid values.",
      );
    }
    validValues = [];
    for (const candidate of option.validValues) {
      const typed = scalarEnvelope(candidate?.value);
      if (
        !typed ||
        typed.kind !== current.kind ||
        !scalarValueMatchesKind(typed.value, typed.kind)
      ) {
        return unsupported(
          "incompatible_valid_values",
          "The selected setting has incompatible native valid values.",
        );
      }
      validValues.push({
        ...(typeof candidate.name === "string" && candidate.name.length > 0
          ? { name: candidate.name }
          : {}),
        ...typed,
      });
    }
    if (!validValues.some((candidate) => sameScalar(candidate, current))) {
      return incompatible(
        "current_value_not_listed",
        "The current setting is not in its explicit valid-values set.",
      );
    }
    const constrainedListContract = {
      kind: current.kind,
      ...numericMetadata.contract,
      ...lengthMetadata.contract,
    };
    if (
      validValues.some(
        ({ value }) =>
          !validateNativeScalarValue(value, constrainedListContract).valid,
      )
    ) {
      return incompatible(
        "inconsistent_valid_values",
        "The selected setting has valid values that contradict its native numeric constraints.",
      );
    }
  }

  return {
    supported: true,
    current,
    contract: {
      type: option.type,
      input_type: inputType,
      kind: current.kind,
      ...numericMetadata.contract,
      ...lengthMetadata.contract,
      ...(validValues ? { valid_values: validValues } : {}),
    },
  };
}

export function validateNativeScalarValue(value, contract) {
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
    return invalidValue(
      "kind_mismatch",
      `The requested value must match ${contract.kind}.`,
    );
  }
  if (
    contract.step !== undefined &&
    typeof value === "number" &&
    !isStepAligned(value, contract.min ?? 0, contract.step)
  ) {
    return invalidValue(
      "step_mismatch",
      "The requested value does not match the native step.",
    );
  }
  if (
    (contract.min !== undefined && value < contract.min) ||
    (contract.max !== undefined && value > contract.max)
  ) {
    return invalidValue(
      "outside_range",
      "The requested value is outside the native range.",
    );
  }
  if (
    typeof value === "string" &&
    ((contract.min_length !== undefined &&
      value.length < contract.min_length) ||
      (contract.max_length !== undefined && value.length > contract.max_length))
  ) {
    return invalidValue(
      "invalid_length",
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
    return invalidValue(
      "not_in_valid_values",
      "The requested value is not in the native valid-values set.",
    );
  }
  return { valid: true, value: { value, kind: contract.kind } };
}

export function isSelectableNativeValidValue(candidate, typedValue, contract) {
  return (
    candidate?.checked !== false &&
    typedValue?.kind === contract.kind &&
    validateNativeScalarValue(typedValue.value, contract).valid
  );
}

export function nativeScalarContract(source, kind) {
  return {
    kind,
    ...(typeof source.minValue === "number" ? { min: source.minValue } : {}),
    ...(typeof source.maxValue === "number" ? { max: source.maxValue } : {}),
    ...(typeof source.minStep === "number" ? { step: source.minStep } : {}),
    ...(typeof source.minLen === "number" ? { min_length: source.minLen } : {}),
    ...(typeof source.maxLen === "number" ? { max_length: source.maxLen } : {}),
  };
}

function inspectLengthMetadata(option, current) {
  const entries = [
    ["minLen", "min_length"],
    ["maxLen", "max_length"],
  ];
  const contract = {};
  for (const [nativeKey, publicKey] of entries) {
    if (option[nativeKey] === undefined) continue;
    if (
      current.kind !== "stringValue" ||
      !Number.isSafeInteger(option[nativeKey]) ||
      option[nativeKey] < 0
    ) {
      return incompatible(
        "invalid_length_constraint",
        "SprutHub returned an invalid length setting constraint.",
      );
    }
    contract[publicKey] = option[nativeKey];
  }
  if (
    contract.min_length !== undefined &&
    contract.max_length !== undefined &&
    contract.min_length > contract.max_length
  ) {
    return incompatible(
      "invalid_length_constraint",
      "SprutHub returned inconsistent length setting constraints.",
    );
  }
  return { supported: true, contract };
}

function inspectNumericMetadata(option, current) {
  const entries = [
    ["minValue", "min"],
    ["maxValue", "max"],
    ["minStep", "step"],
  ];
  const contract = {};
  for (const [nativeKey, publicKey] of entries) {
    if (option[nativeKey] === undefined) continue;
    if (
      !numericKinds.has(current.kind) ||
      !Number.isFinite(option[nativeKey])
    ) {
      return incompatible(
        "invalid_numeric_constraint",
        "SprutHub returned an invalid numeric setting constraint.",
      );
    }
    contract[publicKey] = option[nativeKey];
  }
  if (
    (contract.min !== undefined &&
      contract.max !== undefined &&
      contract.min > contract.max) ||
    (contract.step !== undefined && contract.step <= 0)
  ) {
    return incompatible(
      "invalid_numeric_constraint",
      "SprutHub returned inconsistent numeric setting constraints.",
    );
  }
  return { supported: true, contract };
}

export function scalarEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kinds = [...scalarKinds].filter((kind) => Object.hasOwn(value, kind));
  return kinds.length === 1 ? { value: value[kinds[0]], kind: kinds[0] } : null;
}

function scalarValueMatchesKind(value, kind) {
  if (kind === "boolValue") return typeof value === "boolean";
  if (kind === "stringValue") return typeof value === "string";
  if (["intValue", "longValue"].includes(kind)) {
    return Number.isSafeInteger(value);
  }
  return kind === "doubleValue" && Number.isFinite(value);
}

function sameScalar(left, right) {
  return left.kind === right.kind && Object.is(left.value, right.value);
}

function isStepAligned(value, min, step) {
  if (!Number.isFinite(step) || step <= 0) return false;
  const steps = (value - min) / step;
  const nearestValue = min + Math.round(steps) * step;
  const scale = Math.max(
    1,
    Math.abs(value),
    Math.abs(min),
    Math.abs(nearestValue),
  );
  return Math.abs(value - nearestValue) <= Number.EPSILON * scale * 16;
}

function invalidValue(reason, message) {
  return { valid: false, reason, message };
}

function unsupported(reason, message) {
  return { supported: false, category: "unsupported", reason, message };
}

function rights(reason, message) {
  return { supported: false, category: "rights", reason, message };
}

function hidden(reason, message) {
  return { supported: false, category: "hidden", reason, message };
}

function incompatible(reason, message) {
  return { supported: false, category: "incompatible", reason, message };
}
