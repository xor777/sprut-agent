import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SprutHubClient } from "./spruthub-client.mjs";

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

server.registerTool(
  "read_room",
  {
    title: "Read a SprutHub room",
    description:
      "Read devices and current characteristics in one SprutHub room by its human-readable name.",
    inputSchema: {
      room: z.string().min(1).describe("Human-readable room name"),
    },
    outputSchema: {
      status: z.literal("ok"),
      room: z.object({ ref: z.string(), name: z.string() }),
      devices: z.array(deviceSchema),
      freshness: z.object({
        hubResponseReceivedAt: z.string(),
        measurementAt: z.string().nullable(),
      }),
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
      return {
        content: [
          {
            type: "text",
            text:
              error instanceof Error
                ? error.message
                : "Could not read the SprutHub room.",
          },
        ],
        isError: true,
      };
    }
  },
);

await server.connect(new StdioServerTransport());

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
