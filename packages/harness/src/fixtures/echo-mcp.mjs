// Minimal MCP server for tests: one "echo" tool and one "fail" tool, over stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });

server.registerTool(
  "echo",
  { description: "Repeat the text back", inputSchema: { text: z.string(), times: z.number().optional() } },
  async ({ text, times }) => ({
    content: [{ type: "text", text: `echo: ${text.repeat(times ?? 1)}${process.env.ECHO_SUFFIX ?? ""}` }],
  }),
);

server.registerTool("fail", { description: "Always fails", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: "nope" }],
  isError: true,
}));

await server.connect(new StdioServerTransport());
