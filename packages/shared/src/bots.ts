import { z } from "zod";

import { BotId, ThreadId } from "./ids";
import { ModelRef } from "./models";

/** The avatar shapes a bot can have. */
export const AVATAR_SHAPES = [
  "circle",
  "squircle",
  "hexagon",
  "drop",
  "burst",
  "leaf",
  "moon",
  "diamond",
] as const;
export const AVATAR_COLORS = ["coral", "amber", "lime", "teal", "sky", "violet", "rose", "slate"] as const;

export const AvatarShape = z.enum(AVATAR_SHAPES);
export type AvatarShape = z.infer<typeof AvatarShape>;
export const AvatarColor = z.enum(AVATAR_COLORS);
export type AvatarColor = z.infer<typeof AvatarColor>;
/** An uploaded picture (data URL) replaces the shape when present. */
export const AvatarImage = z
  .string()
  .regex(/^data:image\/(png|jpeg|webp);base64,/)
  .max(400_000);
export const Avatar = z.object({ shape: AvatarShape, color: AvatarColor, image: AvatarImage.optional() });
export type Avatar = z.infer<typeof Avatar>;

export const BotName = z.string().trim().min(1, "Name is required").max(60);
export const BotLabel = z.string().trim().max(80);
/** The bot's standing job description, sent as part of its system prompt. */
export const BotInstructions = z.string().max(8000);

/** A tool's name, or a prefix ending in `*` for a whole family (`gmail__*` for one connected app's tools). */
export const ToolPattern = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\w-]+\*?$/, "Letters, digits, _ and -, with * only at the end");

/**
 * Which tools a bot may use. `exclude` always wins. `allow: null` means every tool; a list means only those, and an
 * empty list means none. A tool added later (a new connected app) is on unless the bot's list says otherwise.
 */
/**
 * How much a bot may do in a connected app: nothing, only look (tools that read), or everything its tools allow.
 * A connected app the bot's list doesn't mention is "full", as it was before access could be set.
 */
export const AppAccess = z.enum(["off", "read", "full"]);
export type AppAccess = z.infer<typeof AppAccess>;

export const BotTools = z.object({
  allow: z.array(ToolPattern).max(300).nullable().default(null),
  exclude: z.array(ToolPattern).max(300).default([]),
  /** Access per connected app, by its id. */
  apps: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/), AppAccess).default({}),
});
export type BotTools = z.infer<typeof BotTools>;
export const DEFAULT_BOT_TOOLS: BotTools = { allow: null, exclude: [], apps: {} };

/** The bot's access to one connected app. */
export const appAccess = (tools: BotTools, connectorId: string): AppAccess =>
  tools.apps[connectorId] ?? "full";

const matchesTool = (pattern: string, name: string) =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;

/** Whether the bot may use this tool. */
export function toolAllowed(tools: BotTools, name: string): boolean {
  if (tools.exclude.some((pattern) => matchesTool(pattern, name))) return false;
  return tools.allow === null || tools.allow.some((pattern) => matchesTool(pattern, name));
}

/** Whether the bot has any restriction at all. */
export const restrictsTools = (tools: BotTools) =>
  tools.allow !== null ||
  tools.exclude.length > 0 ||
  Object.values(tools.apps).some((access) => access !== "full");

export type ToolGroup =
  | "files"
  | "commands"
  | "web"
  | "browser"
  | "computer"
  | "vault"
  | "team"
  | "memory"
  | "skills"
  | "apps"
  | "chat";

/** The tools that let a bot find and use its skills by itself. "Can use skills" switches both. */
export const SKILL_TOOLS = ["find_skills", "use_skill"] as const;

/** In the order the Details panel lists them. */
export const TOOL_GROUPS: { id: ToolGroup; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "commands", label: "Commands" },
  { id: "web", label: "Web" },
  { id: "browser", label: "Browser" },
  { id: "computer", label: "Computer" },
  { id: "apps", label: "Connected apps" },
  { id: "vault", label: "Logins and secrets" },
  { id: "team", label: "Teamwork" },
  { id: "memory", label: "Memory" },
  { id: "skills", label: "Skills" },
  { id: "chat", label: "Chat" },
];

/** A tool as the Details panel shows it. */
export interface ToolInfo {
  name: string;
  description: string;
  group: ToolGroup;
  /** The bot's list lets it use the tool. */
  enabled: boolean;
  /** Offered at the moment. False for a tool its list names but that is gone for now (a stopped computer). */
  available: boolean;
  /** Whether a switch can change it: it isn't held off by a pattern or an allow list the panel doesn't edit. */
  editable: boolean;
  /** Why it is off when no switch here can turn it on ("read-only access to Gmail"); null otherwise. */
  heldBy: string | null;
  /** For a connected app's tool: which app, and what the tool does there. */
  app?: { id: string; name: string; kind: AppToolKind };
}

/**
 * The tool lists after switching one tool on or off. Only the exact name in `exclude` changes: an allow list set
 * through the API is left as it is, so a click in the panel never wipes it.
 */
export function setToolEnabled(tools: BotTools, name: string, enabled: boolean): BotTools {
  const exclude = tools.exclude.filter((existing) => existing !== name);
  return { ...tools, exclude: enabled ? exclude : [...exclude, name] };
}

/** The tool lists with one connected app's access changed; "full" is the default, so it is simply left out. */
export function setAppAccess(tools: BotTools, connectorId: string, access: AppAccess): BotTools {
  const { [connectorId]: _previous, ...rest } = tools.apps;
  return { ...tools, apps: access === "full" ? rest : { ...rest, [connectorId]: access } };
}

/** What a connected app's tool does, as far as can be told: only reads, changes things, or changes them for good. */
export type AppToolKind = "read" | "write" | "destructive";

export const Bot = z.object({
  id: BotId,
  name: BotName,
  label: BotLabel.nullable(),
  avatar: Avatar,
  isPrimary: z.boolean(),
  pinned: z.boolean(),
  hidden: z.boolean(),
  /** null = use the shared local model. */
  model: ModelRef.nullable(),
  instructions: BotInstructions,
  /** Sidebar section name; null = the main list. */
  section: z.string().max(40).nullable(),
  /** Desktop notification when it replies while you are elsewhere. */
  notifications: z.boolean(),
  /** Can create helper bots and delegate to teammates (the primary bot always can). */
  coordinator: z.boolean(),
  /** The coordinator that created this helper; null for bots you made. */
  parentId: BotId.nullable(),
  /** A helper made for a task: hidden when its coordinator's turn ends, deleted when dismissed. */
  temporary: z.boolean(),
  /** A Visual Bot: uses the web only by looking at screenshots and clicking what it sees. */
  visual: z.boolean(),
  /** A Coding Bot: a team of planner, developer and QA roles that builds a project in an output folder. */
  coding: z.boolean().default(false),
  /** A Job Bot: interviews you, then finds and checks jobs that fit you when you start a scan. */
  job: z.boolean().default(false),
  /** A Client Bot: interviews you about what you sell, then finds and checks businesses that may need it when you start a scan. */
  client: z.boolean().default(false),
  /** The cluster (group discussion) this bot was made for; it lives only there. */
  clusterId: ThreadId.nullable().default(null),
  /** Which tools it may use (all by default). Fewer tools means a shorter prompt, which small models need. */
  tools: BotTools.default(DEFAULT_BOT_TOOLS),
  /** The bot's one-to-one thread with the user. */
  threadId: ThreadId,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Bot = z.infer<typeof Bot>;

export const isCoordinator = (bot: Pick<Bot, "isPrimary" | "coordinator" | "parentId">) =>
  bot.parentId === null && (bot.isPrimary || bot.coordinator);

export const CreateBotInput = z.object({
  name: BotName,
  label: BotLabel.nullable().optional(),
  avatar: Avatar.optional(),
  isPrimary: z.boolean().optional(),
  model: ModelRef.nullable().optional(),
  instructions: BotInstructions.optional(),
  coordinator: z.boolean().optional(),
  visual: z.boolean().optional(),
  tools: BotTools.optional(),
});
export type CreateBotInput = z.infer<typeof CreateBotInput>;

export const UpdateBotInput = z
  .object({
    name: BotName,
    label: BotLabel.nullable(),
    avatar: Avatar,
    isPrimary: z.boolean(),
    pinned: z.boolean(),
    hidden: z.boolean(),
    model: ModelRef.nullable(),
    instructions: BotInstructions,
    section: z.string().trim().max(40).nullable(),
    notifications: z.boolean(),
    coordinator: z.boolean(),
    tools: BotTools,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");
export type UpdateBotInput = z.infer<typeof UpdateBotInput>;

/** Order the sidebar shows: primary first, then pinned, then by creation time. */
export function compareBots(a: Bot, b: Bot): number {
  if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt);
}
