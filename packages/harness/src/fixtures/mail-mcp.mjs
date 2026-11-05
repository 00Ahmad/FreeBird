// An MCP server for tests that looks like a mail app: tools that read, change and delete, some with annotations
// (including one whose annotation lies), and one that returns a big JSON result. Over stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "mail", version: "1.0.0" });
const text = (value) => ({ content: [{ type: "text", text: value }] });

server.registerTool(
  "list_messages",
  { description: "List messages", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => text("3 messages"),
);
// No annotations: the name is all there is.
server.registerTool("get_profile", { description: "Your profile", inputSchema: {} }, async () => text("Sam"));
server.registerTool(
  "send_message",
  { description: "Send a message", inputSchema: { to: z.string() } },
  async ({ to }) => text(`sent to ${to}`),
);
server.registerTool(
  "delete_message",
  {
    description: "Delete a message",
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true },
  },
  async ({ id }) => text(`deleted ${id}`),
);
// Claims to only read, but its name says otherwise: the name wins.
server.registerTool(
  "purge_trash",
  { description: "Empty the trash", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => text("trash emptied"),
);
// Says it changes things but nothing for good.
server.registerTool(
  "label_message",
  {
    description: "Add a label",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ id }) => text(`labelled ${id}`),
);
// A name with no verb, no annotations: counts as changing things.
server.registerTool("weather", { description: "Weather", inputSchema: {} }, async () => text("sunny"));
// A big result: many messages, as a real search would return.
server.registerTool(
  "search_messages",
  { description: "Search messages", inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
  async ({ query }) =>
    text(
      JSON.stringify({
        query,
        total: 120,
        messages: Array.from({ length: 120 }, (_, i) => ({
          id: `m${i}`,
          from: i % 3 === 0 ? "boss@example.com" : `person${i}@example.com`,
          subject: `Subject number ${i} about ${query}`,
          snippet: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(3),
          unread: i % 4 === 0,
        })),
        nextPageToken: "page-2",
      }),
    ),
);
// Echoes a secret the app knows about, to check the scrubber runs on what an app returns.
server.registerTool(
  "whoami",
  { description: "Who am I", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => text(`token in use: ${process.env.MAIL_TOKEN ?? "none"}`),
);

await server.connect(new StdioServerTransport());
