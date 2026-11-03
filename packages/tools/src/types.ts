import { z } from "zod";

import type { JsonSchema } from "@mrog/providers";

export interface ToolContext {
  /** The bot's own folder; file tools work here without asking. */
  workspace: string;
  botId: string;
  botName: string;
  threadId: string;
  signal: AbortSignal;
  /** Ask the user a question in the chat and wait for the answer. */
  ask(question: string): Promise<string>;
  /** Extra environment for commands (secrets the user granted). */
  env?: Record<string, string>;
}

/** Warning badges shown on approval cards (UI-SPEC §6). */
export const BADGES = {
  irreversible: "This can't be undone",
  acts: "This may buy, send or change something on the site",
  security: "This changes sign-in or security settings",
  shares: "This shares your data outside this chat",
  outside: "Outside the bot's folder",
  network: "Reaches your local network",
} as const;

export interface Risk {
  /** "safe" runs without asking; "ask" goes through rules and, failing those, the user. */
  level: "safe" | "ask";
  /** Which card the UI shows: a terminal command card or a general one. */
  kind: "general" | "terminal";
  badges: string[];
  /** One line the card shows, e.g. the command or the file path. */
  summary: string;
}

export interface ToolSpec<A = any> {
  name: string;
  description: string;
  args: z.ZodType<A>;
  /** Schema to show the model instead of one derived from `args` (tools that bring their own, e.g. MCP). */
  jsonSchema?: JsonSchema;
  /** Reshape arguments models commonly get slightly wrong (runs after generic normalization, before validation). */
  prepare?(args: Record<string, unknown>): Record<string, unknown>;
  /** May look things up first (e.g. where an address points); `args` is the same object `run` gets next. */
  risk(args: A, ctx: ToolContext): Risk | Promise<Risk>;
  run(args: A, ctx: ToolContext): Promise<string | ToolResult>;
}

/** A result with pictures (e.g. a screenshot), shown to models that can see images. */
export interface ToolResult {
  text: string;
  images: { mediaType: string; data: string }[];
}

export function defineTool<A>(spec: ToolSpec<A>): ToolSpec<A> {
  return spec;
}

export const safe = (summary: string): Risk => ({ level: "safe", kind: "general", badges: [], summary });

/** JSON Schema the model sees for a tool's arguments. */
export function argsSchema(spec: ToolSpec): JsonSchema {
  if (spec.jsonSchema) return spec.jsonSchema;
  const { $schema: _schema, ...rest } = z.toJSONSchema(spec.args, { io: "input" }) as Record<string, unknown>;
  return rest;
}
