import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  AddConnectorInput,
  APP_NAME,
  APP_VERSION,
  appAccess,
  ConnectorConfig,
  PARTLY_HIDDEN_BADGE,
  UpdateConnectorInput,
  type AppToolKind,
  type Bot,
  type ConnectorView,
} from "@mrog/shared";
import { BADGES, defineTool, safe, type ToolSpec } from "@mrog/tools";

import { fail, parse } from "./http";
import {
  ConnectorSignIn,
  OAUTH_CALLBACK_PATH,
  oauthSecretName,
  PendingSignIns,
  SIGN_IN_PAGE_HEADERS,
  signInPage,
} from "./oauth";
import { answerQuery, KEEP_OVER, ResultStore, summary } from "./results";
import type { Services } from "./services";

const KEY = "connectors";
const MAX_RESULT = 20_000;
/** The most of one result that is kept for query_result (a result bigger than this is cut, then kept). */
const MAX_KEPT = 2_000_000;

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** What the server says about the tool (MCP annotations). Claims, not facts: see classifyTool. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

const READ_VERBS = new Set(
  "get list read search find fetch query describe show view lookup look count retrieve browse explore inspect preview download export summarize summarise whoami status info stat ping validate".split(
    " ",
  ),
);
const DESTRUCTIVE_VERBS = new Set(
  "delete remove destroy drop purge wipe erase truncate revoke cancel terminate kill reset overwrite unpublish archive empty clear ban block trash discard rm del prune flush revert rollback withdraw refund void".split(
    " ",
  ),
);
const WRITE_VERBS = new Set(
  "create add insert update edit modify set put patch post send write upload move rename copy share publish merge close reopen open start stop run execute exec trigger submit pay buy purchase transfer mark label assign unassign comment reply forward invite schedule book approve reject star unstar like follow subscribe unsubscribe enable disable install uninstall deploy apply commit push sync import restore grant link unlink attach detach tag untag pin unpin react draft save store register login logout sign accept decline".split(
    " ",
  ),
);

/** The words in a tool name: `send_email`, `createIssue` and `get-file` all split. */
const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * A name that opens with a destructive verb run together with its object (`deleteitem`). Only the first word and only
 * longer verbs, so `get_archived_items` stays a read and "del" is not "delivery".
 */
const opensDestructive = (first: string | undefined) =>
  !!first && [...DESTRUCTIVE_VERBS].some((verb) => verb.length >= 5 && first.startsWith(verb));

/** What a tool's name says it does. Any destructive word wins; a read only counts when nothing says otherwise. */
function kindFromName(name: string): AppToolKind | null {
  const parts = words(name);
  if (parts.some((word) => DESTRUCTIVE_VERBS.has(word)) || opensDestructive(parts[0])) return "destructive";
  if (parts.some((word) => WRITE_VERBS.has(word))) return "write";
  if (parts[0] && READ_VERBS.has(parts[0])) return "read";
  return null;
}

/**
 * What a connected app's tool does. The server's annotations come first, but they are claims from a program the user
 * installed, not something the app can check, so where the name says something worse the name wins: a "read-only"
 * delete_file is a delete. With no annotations the name is all there is; only a plain read verb makes a tool
 * read-only, and anything unclear counts as changing things.
 */
export function classifyTool(tool: Pick<McpTool, "name" | "annotations">): AppToolKind {
  const byName = kindFromName(tool.name);
  const notes = tool.annotations ?? {};
  if (notes.readOnlyHint === true) return byName === "destructive" || byName === "write" ? byName : "read";
  if (notes.readOnlyHint === false || notes.destructiveHint !== undefined) {
    // It says it changes things; the protocol's default is that the change can't be undone unless it says otherwise.
    return notes.destructiveHint === false && byName !== "destructive" ? "write" : "destructive";
  }
  return byName ?? "write";
}

const KIND_WORDS: Record<AppToolKind, string> = {
  read: "only reads",
  write: "changes things",
  destructive: "changes things for good",
};

interface Live {
  client: Client;
  tools: McpTool[];
  /** The name each tool is offered to bots under (see exposedNames), by the tool's own name. */
  names: Map<string, string>;
}

/** Tool names models accept: letters, digits, _ and -, at most 64 characters. */
const toolName = (connectorId: string, tool: string) =>
  `${connectorId.replaceAll("-", "_")}__${tool.replace(/[^\w-]/g, "_")}`.slice(0, 64);

/**
 * The bot-facing name of each of an app's tools. Cleaning a name up can make two the same (`list.items` and
 * `list_items`), and the bot would call one while the checks looked at the other; so tools whose names collide all
 * get a short hash of their own name on the end, whatever order the app lists them in.
 */
export function exposedNames(connectorId: string, tools: McpTool[]): Map<string, string> {
  const plain = tools.map((tool) => toolName(connectorId, tool.name));
  const names = new Map<string, string>();
  const used = new Set<string>();
  tools.forEach((tool, index) => {
    let name = plain[index]!;
    if (plain.filter((other) => other === name).length > 1) {
      const hash = createHash("sha256").update(tool.name).digest("hex").slice(0, 6);
      name = `${name.slice(0, 64 - 7)}_${hash}`;
    }
    // The same tool listed twice, or a hash that lands on another name: still one name each.
    for (let n = 2; used.has(name); n++) name = `${name.slice(0, 64 - 3)}_${n}`;
    used.add(name);
    names.set(tool.name, name);
  });
  return names;
}

/** The most of a call's arguments an approval card shows; what is left out is said so. */
const MAX_SHOWN = 2_000;

/** What an approval card says about a call: all of its arguments up to a limit, and a badge when some are left out. */
function callSummary(label: string, args: unknown): { summary: string; badges: string[] } {
  const text = JSON.stringify(args) ?? "";
  if (text.length <= MAX_SHOWN) return { summary: `${label}(${text})`, badges: [] };
  return {
    summary: `${label}(${text.slice(0, MAX_SHOWN)}… (${text.length - MAX_SHOWN} more characters not shown))`,
    badges: [PARTLY_HIDDEN_BADGE],
  };
}

/** The most pages of tools read from one app, so a server that never stops paging can't hold a connect up for ever. */
const MAX_TOOL_PAGES = 20;

/** Every tool the app lists, following its pages. */
async function listAllTools(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
    tools.push(...(result.tools as McpTool[]));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/** Connected apps over MCP: starts each enabled server, lists its tools, and hands them to bots. */
export class ConnectorManager {
  private readonly live = new Map<string, Live>();
  private readonly status = new Map<string, { state: ConnectorView["state"]; error: string | null }>();
  /**
   * Bumped by every connect and disconnect, so a connect overtaken by a newer one, a remove or a switch-off
   * closes what it opened instead of keeping it.
   */
  private readonly generation = new Map<string, number>();

  /** Takes the user's secret values out of what a connected app returns (set once the scrubber exists). */
  scrub: (text: string) => string = (text) => text;
  /** Big results, kept per bot and chat for query_result. */
  readonly results = new ResultStore();
  /** Sign-ins under way, by their state, and each HTTP app's sign-in keeper. */
  readonly pendingSignIns = new PendingSignIns();
  private readonly signIns = new Map<string, ConnectorSignIn>();
  /** The harness's own address, where a sign-in comes back to (set once it listens). */
  private base: string | null = null;

  setCallbackBase(url: string): void {
    this.base = url;
  }

  /** The sign-in keeper for an HTTP app, made again if its address changed. */
  private signInFor(config: ConnectorConfig): ConnectorSignIn | null {
    if (config.transport.type !== "http") return null;
    // A token the user pasted in is how this app signs in: a refusal is that token's error, not a sign-in to offer.
    if (Object.keys(config.transport.headers).some((name) => name.toLowerCase() === "authorization"))
      return null;
    const url = config.transport.url;
    const existing = this.signIns.get(config.id);
    if (existing?.serverUrl === url) return existing;
    const signIn = new ConnectorSignIn({
      vault: this.services.vault,
      bus: this.services.bus,
      connectorId: config.id,
      serverUrl: url,
      base: () => this.base,
      pending: this.pendingSignIns,
    });
    this.signIns.set(config.id, signIn);
    return signIn;
  }

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
    const signIn = this.signInFor(config);
    if (signIn) signIn.signInUrl = null;
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
              // A server that asks for OAuth gets it; one that doesn't never notices.
              ...(signIn ? { authProvider: signIn } : {}),
            });
      await client.connect(transport, { timeout: 30_000 });
      const tools = await listAllTools(client);
      if (!this.current(config.id, token)) {
        // Superseded, removed or switched off meanwhile: whoever did that owns the status.
        await client.close().catch(() => {});
        return;
      }
      this.live.set(config.id, { client, tools, names: exposedNames(config.id, tools) });
      this.status.set(config.id, { state: "connected", error: null });
      // A server that exits or drops the connection later is no longer there to call. A deliberate disconnect or a
      // newer connect bumps the token first, so it never counts as a loss.
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the MCP client is not an EventTarget
      client.onclose = () => this.lost(config.id, token, `${config.name} stopped or closed the connection.`);
    } catch (error) {
      await client.close().catch(() => {});
      if (!this.current(config.id, token)) return;
      // The SDK's HTTP errors keep the status in `code` and often leave the message empty.
      const status = (error as { code?: unknown }).code;
      const message =
        status === 401 || status === 403
          ? `${config.name} refused the sign-in (HTTP ${status}). Check the token in its settings.`
          : (error as Error).message;
      // The server wants the user to sign in: a button, not an error. Nothing is opened until it is pressed.
      if (error instanceof UnauthorizedError || signIn?.signInUrl) {
        this.status.set(config.id, { state: "auth", error: `Sign in to ${config.name} to use it.` });
      } else {
        this.status.set(config.id, {
          state: "error",
          error: /401|unauthori[sz]ed|forbidden/i.test(message) ? `Needs auth: ${message}` : message,
        });
      }
    }
    this.changed();
  }

  /** The app's connection ended without anyone asking: mark it, take its tools away and tell the UI. */
  private lost(id: string, token: number, message: string): void {
    if (this.generation.get(id) !== token) return;
    this.live.delete(id);
    this.status.set(id, { state: "error", error: message });
    this.changed();
  }

  /**
   * "Sign in": connects again so the server asks for a fresh sign-in, and returns the address to send the user to.
   * `connected` when no sign-in was needed after all (tokens still worked).
   */
  async signIn(id: string): Promise<{ url: string } | { connected: true } | { error: string }> {
    const config = this.configs().find((candidate) => candidate.id === id);
    if (!config) return { error: "No connector has this id." };
    const signIn = this.signInFor(config);
    if (!signIn) return { error: "Only apps added by web address sign in this way." };
    if (!this.base) return { error: "The app isn't ready to receive a sign-in yet. Try again in a moment." };
    signIn.prepareSignIn();
    await this.connect(config);
    if (this.status.get(id)?.state === "connected") return { connected: true };
    return signIn.signInUrl
      ? { url: signIn.signInUrl.toString() }
      : { error: this.status.get(id)?.error ?? "The app didn't offer a way to sign in." };
  }

  /** The user's browser came back with a code: swap it for tokens, then connect with them. */
  async finishSignIn(state: string | undefined, code: string): Promise<{ name: string } | { error: string }> {
    const id = this.pendingSignIns.take(state);
    if (!id)
      return { error: "This sign-in link has expired or was already used. Press Sign in again in FreeBird." };
    const config = this.configs().find((candidate) => candidate.id === id);
    const signIn = config && this.signInFor(config);
    if (!config || !signIn || config.transport.type !== "http")
      return { error: "That app is no longer set up." };
    try {
      const transport = new StreamableHTTPClientTransport(new URL(config.transport.url), {
        requestInit: { headers: this.resolve(config.transport.headers) },
        authProvider: signIn,
      });
      await transport.finishAuth(code);
    } catch (error) {
      return { error: `${config.name} didn't accept the sign-in: ${this.scrub((error as Error).message)}` };
    }
    await this.connect(config);
    return { name: config.name };
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
    // Its sign-in goes with it.
    // (Also one kept from before the user pasted their own token in, which no sign-in keeper is made for.)
    if (this.services.vault.get(oauthSecretName(id)) !== null) {
      this.services.vault.delete(oauthSecretName(id));
      this.services.bus.publish({ type: "secrets.changed", names: this.services.vault.names() });
    }
    this.signIns.delete(id);
    // The list as it is now: an app added while this one closed must not be lost with the old list.
    this.save(this.configs().filter((candidate) => candidate.id !== id));
    return true;
  }

  /** The connected app a bot tool belongs to, and what the tool does there; null for a tool that isn't an app's. */
  describe(specName: string): { id: string; name: string; tool: string; kind: AppToolKind } | null {
    for (const config of this.configs()) {
      const live = this.live.get(config.id);
      const tool = live?.tools.find((candidate) => live.names.get(candidate.name) === specName);
      if (tool) return { id: config.id, name: config.name, tool: tool.name, kind: classifyTool(tool) };
    }
    return null;
  }

  /**
   * Why a bot may not use this app tool, or null when it may: no access to the app, or read-only access and a tool
   * that changes things. Put in the agent's gates, so it narrows the same list as the bot's tool switches.
   */
  gate(bot: Bot, specName: string): string | null {
    const app = this.describe(specName);
    if (!app) return null;
    const access = appAccess(bot.tools, app.id);
    if (access === "off") return `no access to ${app.name}`;
    if (access === "read" && app.kind !== "read")
      return `read-only access to ${app.name} (this tool ${KIND_WORDS[app.kind]})`;
    return null;
  }

  /** The prompt's line about apps this bot may only read from. */
  accessNote(bot: Bot): string | null {
    const readOnly = this.configs().filter(
      (config) => this.live.has(config.id) && appAccess(bot.tools, config.id) === "read",
    );
    if (readOnly.length === 0) return null;
    const names = readOnly.map((config) => config.name).join(", ");
    return `You may only look things up in ${names}: tools that change anything there are not available to you. If a job needs a change there, say so instead of trying.`;
  }

  /** Every enabled tool of every connected app, as bot tools. */
  toolSpecs(): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const config of this.configs()) {
      const live = this.live.get(config.id);
      if (!config.enabled || !live) continue;
      for (const tool of live.tools) {
        if (config.disabledTools.includes(tool.name)) continue;
        const kind = classifyTool(tool);
        specs.push(
          defineTool({
            name: live.names.get(tool.name)!,
            description: `[${config.name}] ${tool.description ?? tool.name}`.slice(0, 1000),
            args: z.record(z.string(), z.unknown()),
            jsonSchema: { type: "object", ...tool.inputSchema },
            risk: (args) => {
              const { summary: what, badges: unseen } = callSummary(`${config.name} → ${tool.name}`, args);
              // Only a tool that only reads leaves nothing behind if the app dies mid-call.
              const outward = kind !== "read";
              // One that can't be undone asks every time (its card offers no "Always allow"), even from an app set
              // not to ask. The user's "ask first" is never loosened by what a server says about its tools.
              if (kind === "destructive")
                return {
                  level: "ask",
                  kind: "general",
                  badges: [BADGES.irreversible, BADGES.shares, ...unseen],
                  summary: what,
                  outward,
                };
              return config.askBeforeUse
                ? {
                    level: "ask",
                    kind: "general",
                    badges: [BADGES.shares, ...unseen],
                    summary: what,
                    outward,
                  }
                : { ...safe(`${config.name} → ${tool.name}`), outward };
            },
            run: async (args, ctx) => {
              let result: {
                content?: { type: string; text?: string; resource?: { text?: string } }[];
                isError?: boolean;
              };
              try {
                result = (await live.client.callTool({ name: tool.name, arguments: args }, undefined, {
                  signal: ctx.signal,
                  timeout: 120_000,
                })) as typeof result;
              } catch (error) {
                // A web app's session can end without the connection closing (the server answers "not found"): from
                // then on every call fails, so say the app is gone instead of leaving it looking connected.
                const gone = /not connected|connection closed/i.test((error as Error).message);
                if (gone || (error as { code?: unknown }).code === 404) {
                  const token = this.generation.get(config.id);
                  if (token !== undefined && this.live.get(config.id) === live)
                    this.lost(config.id, token, `${config.name} is no longer connected. Press Reconnect.`);
                }
                throw error;
              }
              // Secrets out first: what is kept below must be as clean as what is shown.
              const text = this.scrub(
                (result.content ?? [])
                  .map((item) =>
                    item.type === "text"
                      ? (item.text ?? "")
                      : item.type === "resource"
                        ? (item.resource?.text ?? "")
                        : `[${item.type}]`,
                  )
                  .join("\n")
                  .slice(0, MAX_KEPT),
              );
              if (result.isError) throw new Error(text.slice(0, MAX_RESULT) || `${tool.name} failed.`);
              if (!text) return "(no output)";
              if (text.length <= KEEP_OVER) return text;
              // Too big to show whole: kept, and the bot is shown its structure to read from.
              const label = `${config.name} → ${tool.name}`;
              const id = this.results.put(ctx.botId, ctx.threadId, label, text);
              return summary(id, label, this.results.get(ctx.botId, ctx.threadId, id)!);
            },
          }),
        );
      }
    }
    // Offered from the start of the turn whenever there are app tools: a turn's tools are fixed once it starts, so it
    // can't appear only after a big result arrives.
    if (specs.length > 0) specs.push(this.queryTool());
    return specs;
  }

  private queryTool(): ToolSpec {
    return defineTool({
      name: "query_result",
      description:
        'Read part of a large result from a connected app that was kept instead of shown whole (its id looks like "r1"). For JSON give a path: "items[0:10].name", "items[*].id", "items[?status==open]", "items[?subject~invoice].from". For text give lines ("100-200") or find (a word). With only the id you get its shape.',
      args: z.object({
        id: z.string().trim().min(1).max(20),
        path: z.string().max(300).optional(),
        find: z.string().max(200).optional(),
        lines: z.string().max(30).optional(),
      }),
      risk: (args) => safe(`Read part of kept result ${args.id}`),
      run: async (args, ctx) => {
        const kept = this.results.get(ctx.botId, ctx.threadId, args.id);
        if (!kept) {
          const known = this.results.list(ctx.botId, ctx.threadId);
          return known.length > 0
            ? `There is no kept result "${args.id}" in this chat. Kept: ${known.map((entry) => `${entry.id} (${entry.label})`).join(", ")}.`
            : `There is no kept result "${args.id}": nothing has been kept in this chat (or it was cleared).`;
        }
        try {
          return answerQuery(kept, args);
        } catch (error) {
          return (error as Error).message;
        }
      },
    });
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

  /** "Sign in": the address to open in the user's browser (the UI opens it; the harness never does). */
  app.post<{ Params: { id: string } }>("/api/connectors/:id/sign-in", async (request, reply) => {
    const outcome = await manager.signIn(request.params.id);
    if ("error" in outcome) return fail(reply, 409, "sign_in_failed", outcome.error);
    return outcome;
  });

  /**
   * Where the user's browser comes back after signing in. Outside /api and without the app's token (the browser
   * has none): what makes it safe is the state, which works once, for one sign-in, for ten minutes.
   */
  app.get<{ Querystring: Record<string, unknown> }>(OAUTH_CALLBACK_PATH, async (request, reply) => {
    // A repeated query parameter arrives as a list: only a single value counts.
    const text = (value: unknown) => (typeof value === "string" ? value : undefined);
    const code = text(request.query.code);
    const state = text(request.query.state);
    const error = text(request.query.error);
    const description = text(request.query.error_description);
    const page = (status: number, title: string, detail: string) =>
      reply.code(status).headers(SIGN_IN_PAGE_HEADERS).send(signInPage(title, detail));
    if (error) {
      // Still used up, so the same link can't be tried again.
      manager.pendingSignIns.take(state);
      return page(400, "Sign-in didn't finish", description ? `${error}: ${description}` : error);
    }
    if (!code) return page(400, "Sign-in didn't finish", "The app didn't send back a sign-in code.");
    const outcome = await manager.finishSignIn(state, code);
    return "error" in outcome
      ? page(400, "Sign-in didn't finish", outcome.error)
      : page(200, `Signed in to ${outcome.name}`, "You can close this tab and go back to FreeBird.");
  });

  app.delete<{ Params: { id: string } }>("/api/connectors/:id", async (request, reply) => {
    return (await manager.remove(request.params.id))
      ? reply.code(204).send()
      : fail(reply, 404, "not_found", "No connector has this id.");
  });
}
