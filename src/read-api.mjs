import { validateReadSelection } from "./read-selection.mjs";
import { SprutHubError, sanitizeAgentOutput } from "./spruthub-client.mjs";
import { SprutHubConnection } from "./spruthub-connection.mjs";

const RETRYABLE_CODES = new Set([
  "authentication_delayed",
  "connection_closed",
  "connection_failed",
  "invalid_message",
  "timeout",
]);

export function createSprutHubReader({
  env = process.env,
  connection = new SprutHubConnection({ env }),
} = {}) {
  let client;

  return {
    async read(selection) {
      const normalized = validateReadSelection(selection);
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
