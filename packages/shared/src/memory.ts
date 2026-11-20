import { z } from "zod";

import { BotId } from "./ids";

/** One thing a bot remembers. The user can read, edit and delete every note. */
export const MemoryNote = z.object({
  id: z.string(),
  botId: BotId,
  text: z.string().min(1).max(2000),
  /** Pinned by the user: always sent to the model, however old, and never deleted by the bot's forget. */
  pinned: z.boolean().default(false),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type MemoryNote = z.infer<typeof MemoryNote>;

export const MemoryInput = z.object({ text: z.string().trim().min(1).max(2000) });

/** At most this many notes of one bot can be pinned. */
export const MAX_PINNED_NOTES = 10;

/** A change to a note: its text, whether it is pinned, or both. */
export const UpdateMemoryInput = z
  .object({ text: z.string().trim().min(1).max(2000), pinned: z.boolean() })
  .partial()
  .refine((value) => value.text !== undefined || value.pinned !== undefined, "Nothing to update");

/** Import from another assistant: one note per non-empty line (or paragraph). */
export const ImportMemoryInput = z.object({ text: z.string().trim().min(1).max(100_000) });

/** A saved prompt: typed as "/name" in the composer, or found and used by a bot itself when it can use skills. */
export const Skill = z.object({
  id: z.string(),
  /** null = available to every bot. */
  botId: BotId.nullable(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[\w-]+$/, "Letters, numbers, - and _ only"),
  prompt: z.string().trim().min(1).max(8000),
  /** When to use it, in one line: what a bot reads to pick it. */
  description: z.string().trim().max(400).default(""),
  createdAt: z.iso.datetime(),
});
export type Skill = z.infer<typeof Skill>;

/** No default on the description: an edit that leaves it out keeps it. */
export const SkillInput = Skill.pick({ botId: true, name: true, prompt: true }).extend({
  description: z.string().trim().max(400).optional(),
});
export type SkillInput = z.infer<typeof SkillInput>;
