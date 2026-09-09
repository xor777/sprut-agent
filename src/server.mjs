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
const errorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    action: z.string().optional(),
  })
  .optional();
const freshnessSchema = z.object({
  hubResponseReceivedAt: z.string(),
  measurementAt: z.string().nullable(),
});
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

server.registerTool(
  "list_rooms",
  {
    title: "List SprutHub rooms",
    description:
      "List every room on the configured SprutHub with its original name and stable reference. Use this before read_room. If several rooms plausibly match the user's words, ask which one they mean or read and report each room separately by its original name. Never merge distinct rooms because their readings are equal.",
    inputSchema: {},
    outputSchema: {
      status: z.enum(["ok", "error"]),
      rooms: z.array(roomSchema).optional(),
      error: errorSchema,
      freshness: freshnessSchema.optional(),
    },
    annotations: readOnlyAnnotations,
  },
  async () => runRoomTool(() => getHubClient().listRooms()),
);

server.registerTool(
  "read_room",
  {
    title: "Read a SprutHub room",
    description:
      "Read devices and current characteristics in one SprutHub room selected by a stable reference returned by list_rooms. Keep the returned room name attached to its readings in the answer. If several candidate rooms are read, ask the user to choose or label each result by its original room name; never merge identical readings from distinct rooms.",
    inputSchema: {
      room_ref: z
        .string()
        .min(1)
        .describe("spruthub://room/<id> reference returned by list_rooms"),
    },
    outputSchema: {
      status: z.enum(["ok", "error"]),
      room: roomSchema.optional(),
      devices: z.array(deviceSchema).optional(),
      error: errorSchema,
      freshness: freshnessSchema.optional(),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ room_ref: roomRef }) =>
    runRoomTool(() => getHubClient().readRoom(roomRef)),
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
        ...(error.action ? { action: error.action } : {}),
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

async function runRoomTool(operation) {
  try {
    const result = await operation();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  } catch (error) {
    const result = toToolError(error);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: true,
    };
  }
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await hubClient?.close();
  process.exit(0);
}
