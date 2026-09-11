import { SprutHubError } from "./spruthub-client.mjs";

const CHARACTERISTIC_REF =
  /^(spruthub:\/\/hub\/[^/]+)\/accessory\/[^/]+\/service\/[^/]+\/characteristic\/[^/]+$/;

export function validateReadSelection(selection) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw invalidSelection("Supply one home_ref and its selected readings.");
  }
  const homeRef = selection.homeRef;
  if (
    typeof homeRef !== "string" ||
    !/^spruthub:\/\/hub\/[^/]+$/.test(homeRef)
  ) {
    throw invalidSelection("homeRef must be a home reference from list_homes.");
  }
  if (
    !Array.isArray(selection.readings) ||
    selection.readings.length === 0 ||
    selection.readings.length > 100
  ) {
    throw invalidSelection("Select between 1 and 100 readings.");
  }
  const readings = selection.readings.map((reading) => {
    if (!reading || typeof reading !== "object" || Array.isArray(reading)) {
      throw invalidSelection("Every reading needs a ref and label.");
    }
    const match =
      typeof reading.ref === "string"
        ? reading.ref.match(CHARACTERISTIC_REF)
        : null;
    if (match?.[1] !== homeRef) {
      throw invalidSelection(
        "Every reading must be a characteristic reference in the selected home.",
      );
    }
    if (
      typeof reading.label !== "string" ||
      reading.label.trim().length === 0 ||
      reading.label.length > 200
    ) {
      throw invalidSelection("Every reading needs a short non-empty label.");
    }
    return { ref: reading.ref, label: reading.label };
  });
  return { homeRef, readings };
}

function invalidSelection(message) {
  return new SprutHubError("invalid_selection", message, "fix_read_selection");
}
