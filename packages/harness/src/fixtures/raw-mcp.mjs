// An MCP server for tests that answers tools/list itself, so it can do what the high-level helper won't: split the
// list into pages (RAW_MODE=paged) or list tool names that look the same once cleaned up (RAW_MODE=collide). Over stdio.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const tool = (name, extra = {}) => ({ name, description: name, inputSchema: { type: "object" }, ...extra });

const paged = [["alpha_one", "alpha_two"], ["beta_one"], ["gamma_one", "gamma_two"]];
const collide = [
  // No annotations and a read verb: a read.
  tool("list_items"),
  // Cleans up to the same name, and says it changes things.
  tool("list.items", { annotations: { readOnlyHint: false } }),
];

const server = new Server({ name: "raw", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  if (process.env.RAW_MODE === "collide") return { tools: collide };
  const page = Number(request.params?.cursor ?? 0);
  return {
    tools: paged[page].map((name) => tool(name)),
    ...(page + 1 < paged.length ? { nextCursor: String(page + 1) } : {}),
  };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: `ran ${request.params.name}` }],
}));

await server.connect(new StdioServerTransport());
