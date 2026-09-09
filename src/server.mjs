import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SprutHubClient, SprutHubError } from "./spruthub-client.mjs";

const server = new McpServer({ name: "sprut-agent", version: "0.1.0" });
let hubClient;

const readingSchema = z.object({
  ref: z.string(),
  name: z.string(),
  type: z.string(),
  value: z.union([z.boolean(), z.number(), z.string(), z.null()]),
  unit: z.string().nullable(),
  measuredAt: z.string().nullable(),
});

const serviceSchema = z.object({
  ref: z.string(),
  name: z.string(),
  type: z.string(),
  readings: z.array(readingSchema),
});

const deviceSchema = z.object({
  ref: z.string(),
  name: z.string(),
  available: z.boolean(),
  services: z.array(serviceSchema),
});

const roomSchema = z.object({ ref: z.string(), name: z.string() });

server.registerTool(
  "read_room",
  {
    title: "Read a SprutHub room",
    description:
      "Read devices and current characteristics in one SprutHub room by its human-readable name or stable room reference.",
    inputSchema: {
      room: z
        .string()
        .min(1)
        .describe("Human-readable room name or spruthub://room/<id> reference"),
    },
    outputSchema: {
      status: z.enum(["ok", "ambiguous", "error"]),
      query: z.string().optional(),
      candidates: z.array(roomSchema).optional(),
      room: roomSchema.optional(),
      devices: z.array(deviceSchema).optional(),
      error: z
        .object({
          code: z.string(),
          message: z.string(),
          retryable: z.boolean(),
        })
        .optional(),
      freshness: z
        .object({
          hubResponseReceivedAt: z.string(),
          measurementAt: z.string().nullable(),
        })
        .optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ room }) => {
    try {
      const reading = await getHubClient().readRoom(room);
      return {
        content: [{ type: "text", text: JSON.stringify(reading, null, 2) }],
        structuredContent: reading,
      };
    } catch (error) {
      const result = toToolError(error);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: true,
      };
    }
  },
);

await server.connect(new StdioServerTransport());
process.stdin.once("end", shutdown);
process.once("SIGTERM", shutdown);

function getHubClient() {
  hubClient ??= new SprutHubClient({
    url: process.env.SPRUTHUB_URL,
    token: process.env.SPRUTHUB_TOKEN,
    serial: process.env.SPRUTHUB_SERIAL,
    cid: process.env.SPRUTHUB_CID,
    timeoutMs: Number(process.env.SPRUTHUB_TIMEOUT_MS ?? 10_000),
  });
  return hubClient;
}

function toToolError(error) {
  if (error instanceof SprutHubError) {
    return {
      status: "error",
      error: {
        code: error.code,
        message: error.message,
        retryable: [
          "connection_closed",
          "connection_failed",
          "timeout",
        ].includes(error.code),
      },
    };
  }
  return {
    status: "error",
    error: {
      code: "internal_error",
      message: "Could not read the SprutHub room.",
      retryable: false,
    },
  };
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await hubClient?.close();
  process.exit(0);
}
