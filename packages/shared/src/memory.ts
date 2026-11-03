import { z } from "zod";

import { BotId } from "./ids";

/** One thing a bot remembers. The user can read, edit and delete every note (unlike Grok Bot). */
export const MemoryNote = z.object({
  id: z.string(),
  botId: BotId,
  text: z.string().min(1).max(2000),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type MemoryNote = z.infer<typeof MemoryNote>;

export const MemoryInput = z.object({ text: z.string().trim().min(1).max(2000) });

/** Import from another assistant: one note per non-empty line (or paragraph). */
export const ImportMemoryInput = z.object({ text: z.string().trim().min(1).max(100_000) });

/** A saved prompt invoked with "/name" in the composer (UI-SPEC §5). */
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
  createdAt: z.iso.datetime(),
});
export type Skill = z.infer<typeof Skill>;

export const SkillInput = Skill.pick({ botId: true, name: true, prompt: true });
export type SkillInput = z.infer<typeof SkillInput>;
