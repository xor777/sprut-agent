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
]);

export function inspectNativeOption(option, { requireWrite = true } = {}) {
  if (!option || typeof option !== "object" || Array.isArray(option)) {
    return incompatible(
      "invalid_option",
      "SprutHub returned an invalid option.",
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
  } else if (inputType !== "LIST") {
    return unsupported(
      "unsupported_input_type",
      "Only NUMBER, CHECKBOX, and LIST settings are supported.",
    );
  }

  const numericMetadata = inspectNumericMetadata(option, current);
  if (!numericMetadata.supported) return numericMetadata;

  let validValues;
  if (inputType === "LIST") {
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
  }

  return {
    supported: true,
    current,
    contract: {
      type: option.type,
      input_type: inputType,
      kind: current.kind,
      ...numericMetadata.contract,
      ...(validValues ? { valid_values: validValues } : {}),
    },
  };
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

function scalarEnvelope(value) {
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

function unsupported(reason, message) {
  return { supported: false, category: "unsupported", reason, message };
}

function rights(reason, message) {
  return { supported: false, category: "rights", reason, message };
}

function incompatible(reason, message) {
  return { supported: false, category: "incompatible", reason, message };
}
