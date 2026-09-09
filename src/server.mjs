import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "sprut-agent", version: "0.1.0" });

server.registerTool(
  "read_room",
  {
    title: "Read a SprutHub room",
    description:
      "Read devices and current characteristics in one SprutHub room by its human-readable name.",
    inputSchema: {
      room: z.string().min(1).describe("Human-readable room name"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ room }) => ({
    content: [
      {
        type: "text",
        text: `Room reading is not implemented for ${JSON.stringify(room)}.`,
      },
    ],
    isError: true,
  }),
);

await server.connect(new StdioServerTransport());
