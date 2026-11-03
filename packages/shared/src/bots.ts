import { z } from "zod";

import { BotId, ThreadId } from "./ids";
import { ModelRef } from "./models";

/** Our own avatar shapes (UI-SPEC §3): deliberately not Grok Bot's set. */
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
  /** The cluster (group discussion) this bot was made for; it lives only there. */
  clusterId: ThreadId.nullable().default(null),
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
