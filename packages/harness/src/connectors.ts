import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  AddConnectorInput,
  APP_NAME,
  APP_VERSION,
  ConnectorConfig,
  UpdateConnectorInput,
  type ConnectorView,
} from "@mrog/shared";
import { BADGES, defineTool, safe, type ToolSpec } from "@mrog/tools";

import { fail, parse } from "./http";
import type { Services } from "./services";

const KEY = "connectors";
const MAX_RESULT = 20_000;

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface Live {
  client: Client;
  tools: McpTool[];
}

/** Tool names models accept: letters, digits, _ and -, at most 64 characters. */
const toolName = (connectorId: string, tool: string) =>
  `${connectorId.replaceAll("-", "_")}__${tool.replace(/[^\w-]/g, "_")}`.slice(0, 64);

/** Connected apps over MCP: starts each enabled server, lists its tools, and hands them to bots. */
export class ConnectorManager {
  private readonly live = new Map<string, Live>();
  private readonly status = new Map<string, { state: ConnectorView["state"]; error: string | null }>();
  /**
   * Bumped by every connect and disconnect, so a connect overtaken by a newer one, a remove or a switch-off
   * closes what it opened instead of keeping it.
   */
  private readonly generation = new Map<string, number>();

  constructor(private readonly services: Pick<Services, "store" | "vault" | "bus">) {}

  configs(): ConnectorConfig[] {
    const parsed = z.array(ConnectorConfig).safeParse(this.services.store.settings.get(KEY) ?? []);
    return parsed.success ? parsed.data : [];
  }

  private save(configs: ConnectorConfig[]) {
    this.services.store.settings.set(KEY, configs);
    this.changed();
  }

  private changed() {
    this.services.bus.publish({ type: "data.changed", keys: ["connectors"] });
  }

  /** "vault:NAME" values come from the keychain at connect time. */
  private resolve(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        value.startsWith("vault:") ? (this.services.vault.get(value.slice(6)) ?? "") : value,
      ]),
    );
  }

  private bump(id: string): number {
    const next = (this.generation.get(id) ?? 0) + 1;
    this.generation.set(id, next);
    return next;
  }

  /** Still the newest connect for its id, and the connector is still there and on. */
  private current(id: string, token: number): boolean {
    return (
      this.generation.get(id) === token && this.configs().some((config) => config.id === id && config.enabled)
    );
  }

  async connect(config: ConnectorConfig): Promise<void> {
    await this.disconnect(config.id);
    const token = this.bump(config.id);
    // Removed or switched off while the old one closed.
    if (!this.current(config.id, token)) return;
    this.status.set(config.id, { state: "connecting", error: null });
    this.changed();
    const client = new Client({ name: APP_NAME, version: APP_VERSION });
    try {
      const transport =
        config.transport.type === "stdio"
          ? new StdioClientTransport({
              command: config.transport.command,
              args: config.transport.args,
              env: { ...getDefaultEnvironment(), ...this.resolve(config.transport.env) },
              stderr: "ignore",
            })
          : new StreamableHTTPClientTransport(new URL(config.transport.url), {
              requestInit: { headers: this.resolve(config.transport.headers) },
            });
      await client.connect(transport, { timeout: 30_000 });
      const { tools } = await client.listTools(undefined, { timeout: 30_000 });
      if (!this.current(config.id, token)) {
        // Superseded, removed or switched off meanwhile: whoever did that owns the status.
        await client.close().catch(() => {});
        return;
      }
      this.live.set(config.id, { client, tools: tools as McpTool[] });
      this.status.set(config.id, { state: "connected", error: null });
    } catch (error) {
      await client.close().catch(() => {});
      if (!this.current(config.id, token)) return;
      const message = (error as Error).message;
      this.status.set(config.id, {
        state: "error",
        error: /401|unauthori[sz]ed|forbidden/i.test(message) ? `Needs auth: ${message}` : message,
      });
    }
    this.changed();
  }

  async disconnect(id: string): Promise<void> {
    this.bump(id);
    const live = this.live.get(id);
    this.live.delete(id);
    this.status.set(id, { state: "off", error: null });
    await live?.client.close().catch(() => {});
  }

  async connectAll(): Promise<void> {
    await Promise.all(
      this.configs()
        .filter((config) => config.enabled)
        .map((config) => this.connect(config)),
    );
  }

  async closeAll(): Promise<void> {
    // Connects still in flight are included, so they close what they open.
    const ids = new Set([...this.live.keys(), ...this.generation.keys()]);
    await Promise.all([...ids].map((id) => this.disconnect(id)));
  }

  view(config: ConnectorConfig): ConnectorView {
    const status = this.status.get(config.id) ?? {
      state: config.enabled ? "connecting" : "off",
      error: null,
    };
    const tools = this.live.get(config.id)?.tools ?? [];
    return {
      ...config,
      state: status.state,
      error: status.error,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        enabled: !config.disabledTools.includes(tool.name),
      })),
    };
  }

  async add(input: AddConnectorInput): Promise<ConnectorConfig> {
    const base =
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 24) || "app";
    const taken = new Set(this.configs().map((config) => config.id));
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const config: ConnectorConfig = {
      id,
      name: input.name,
      transport: input.transport,
      enabled: true,
      disabledTools: [],
      askBeforeUse: input.askBeforeUse ?? true,
    };
    this.save([...this.configs(), config]);
    await this.connect(config);
    return config;
  }

  async update(id: string, patch: z.infer<typeof UpdateConnectorInput>): Promise<ConnectorConfig | null> {
    const configs = this.configs();
    const current = configs.find((config) => config.id === id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.save(configs.map((config) => (config.id === id ? next : config)));
    const reconnect =
      patch.transport !== undefined || (patch.enabled !== undefined && patch.enabled !== current.enabled);
    if (reconnect) {
      if (next.enabled) await this.connect(next);
      else await this.disconnect(id);
      this.changed();
    }
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const configs = this.configs();
    if (!configs.some((config) => config.id === id)) return false;
    await this.disconnect(id);
    this.status.delete(id);
    this.save(configs.filter((config) => config.id !== id));
    return true;
  }

  /** Every enabled tool of every connected app, as bot tools. */
  toolSpecs(): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const config of this.configs()) {
      const live = this.live.get(config.id);
      if (!config.enabled || !live) continue;
      for (const tool of live.tools) {
        if (config.disabledTools.includes(tool.name)) continue;
        specs.push(
          defineTool({
            name: toolName(config.id, tool.name),
            description: `[${config.name}] ${tool.description ?? tool.name}`.slice(0, 1000),
            args: z.record(z.string(), z.unknown()),
            jsonSchema: { type: "object", ...tool.inputSchema },
            risk: (args) =>
              config.askBeforeUse
                ? {
                    level: "ask",
                    kind: "general",
                    badges: [BADGES.shares],
                    summary: `${config.name} → ${tool.name}(${JSON.stringify(args).slice(0, 200)})`,
                  }
                : safe(`${config.name} → ${tool.name}`),
            run: async (args, ctx) => {
              const result = (await live.client.callTool({ name: tool.name, arguments: args }, undefined, {
                signal: ctx.signal,
                timeout: 120_000,
              })) as {
                content?: { type: string; text?: string; resource?: { text?: string } }[];
                isError?: boolean;
              };
              const text = (result.content ?? [])
                .map((item) =>
                  item.type === "text"
                    ? (item.text ?? "")
                    : item.type === "resource"
                      ? (item.resource?.text ?? "")
                      : `[${item.type}]`,
                )
                .join("\n")
                .slice(0, MAX_RESULT);
              if (result.isError) throw new Error(text || `${tool.name} failed.`);
              return text || "(no output)";
            },
          }),
        );
      }
    }
    return specs;
  }
}

export function registerConnectorRoutes(app: FastifyInstance, manager: ConnectorManager) {
  app.get("/api/connectors", async () => ({
    connectors: manager.configs().map((config) => manager.view(config)),
  }));

  app.post("/api/connectors", async (request, reply) => {
    const input = parse(AddConnectorInput, request.body, reply);
    if (!input) return reply;
    const config = await manager.add(input);
    return reply.code(201).send({ connector: manager.view(config) });
  });

  app.patch<{ Params: { id: string } }>("/api/connectors/:id", async (request, reply) => {
    const input = parse(UpdateConnectorInput, request.body, reply);
    if (!input) return reply;
    const config = await manager.update(request.params.id, input);
    return config
      ? { connector: manager.view(config) }
      : fail(reply, 404, "not_found", "No connector has this id.");
  });

  app.post<{ Params: { id: string } }>("/api/connectors/:id/reconnect", async (request, reply) => {
    const config = manager.configs().find((candidate) => candidate.id === request.params.id);
    if (!config) return fail(reply, 404, "not_found", "No connector has this id.");
    await manager.connect(config);
    return { connector: manager.view(config) };
  });

  app.delete<{ Params: { id: string } }>("/api/connectors/:id", async (request, reply) => {
    return (await manager.remove(request.params.id))
      ? reply.code(204).send()
      : fail(reply, 404, "not_found", "No connector has this id.");
  });
}
