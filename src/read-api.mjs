import { SprutHubError, sanitizeAgentOutput } from "./spruthub-client.mjs";
import { SprutHubConnection } from "./spruthub-connection.mjs";

const RETRYABLE_CODES = new Set([
  "authentication_delayed",
  "connection_closed",
  "connection_failed",
  "invalid_message",
  "timeout",
]);
const CHARACTERISTIC_REF =
  /^(spruthub:\/\/hub\/[^/]+)\/accessory\/[^/]+\/service\/[^/]+\/characteristic\/[^/]+$/;

export function createSprutHubReader({
  env = process.env,
  connection = new SprutHubConnection({ env }),
} = {}) {
  let client;

  return {
    async read(selection) {
      const normalized = validateSelection(selection);
      let activeClient;
      try {
        activeClient = client ??= await connection.getClient();
      } catch (error) {
        return safeResult(
          {
            status: "error",
            readings: normalized.readings.map(({ ref, label }) => ({
              ref,
              label,
              status: "error",
              error: publicError(error),
            })),
          },
          connection,
        );
      }

      const readings = await Promise.all(
        normalized.readings.map(async ({ ref, label }) => {
          try {
            return normalizeReading(await activeClient.getEntity(ref), {
              ref,
              label,
            });
          } catch (error) {
            return { ref, label, status: "error", error: publicError(error) };
          }
        }),
      );
      const successful = readings.filter(
        ({ status }) => status === "ok" || status === "unavailable",
      ).length;
      return safeResult(
        {
          status:
            successful === readings.length
              ? "ok"
              : successful === 0
                ? "error"
                : "degraded",
          readings,
        },
        connection,
      );
    },

    async close() {
      if (!client) return;
      const activeClient = client;
      client = undefined;
      await activeClient.close();
    },
  };
}

function validateSelection(selection) {
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

function normalizeReading(result, selected) {
  const entity = result?.entity;
  if (
    result?.status !== "ok" ||
    entity?.kind !== "characteristic" ||
    entity.ref !== selected.ref
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned an incompatible selected reading.",
    );
  }
  if (entity.redacted === true || entity.capabilities?.read !== true) {
    throw new SprutHubError(
      "reading_unavailable",
      "The selected SprutHub characteristic is not readable.",
      "choose_readable_characteristic",
    );
  }
  const current = entity.current_value;
  if (
    !current ||
    (!["boolean", "number", "string"].includes(typeof current.value) &&
      current.value !== null)
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned an incompatible selected value.",
    );
  }
  const choices = entity.capabilities.valid_values ?? [];
  const choice = choices.find(({ value }) => Object.is(value, current.value));
  const observedAt = result.freshness?.hubResponseReceivedAt;
  if (
    typeof observedAt !== "string" ||
    !Number.isFinite(Date.parse(observedAt))
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub did not provide a valid response time for the selected value.",
    );
  }
  return {
    ...selected,
    status: entity.available === false ? "unavailable" : "ok",
    value: current.value,
    unit: entity.capabilities.unit ?? null,
    enum: choice ? { key: choice.key, name: choice.name } : null,
    available: entity.available !== false,
    observed_at: observedAt,
    measured_at: current.source_timestamp ?? null,
  };
}

function publicError(error) {
  if (error instanceof SprutHubError) {
    return {
      code: error.code,
      message: error.message,
      retryable: RETRYABLE_CODES.has(error.code),
      ...(error.action ? { action: error.action } : {}),
    };
  }
  return {
    code: "internal_error",
    message: "Could not read the selected SprutHub value.",
    retryable: false,
  };
}

function safeResult(result, connection) {
  return sanitizeAgentOutput(result, connection.secrets ?? []);
}

function invalidSelection(message) {
  return new SprutHubError(
    "invalid_selection",
    message,
    "fix_dashboard_selection",
  );
}
