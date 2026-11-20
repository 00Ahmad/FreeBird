import { z } from "zod";

import { BotId, MessageId, ThreadId } from "./ids";

export const ToolStatus = z.enum(["pending_approval", "running", "done", "error", "denied"]);
export type ToolStatus = z.infer<typeof ToolStatus>;

/** Which of the three Parallel Bots roles (1 to 3) a part belongs to, when each role ran as its own conversation. */
export const ParallelLane = z.number().int().min(1).max(3).optional();

export const MessagePart = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    lane: ParallelLane,
    /** On a lane's heading part: that role has finished (answered, failed or was stopped). */
    laneDone: z.boolean().optional(),
  }),
  z.object({ type: z.literal("reasoning"), text: z.string(), lane: ParallelLane }),
  /** Base64 image the user attached (sent to vision models). */
  z.object({ type: z.literal("image"), mediaType: z.string(), data: z.string() }),
  z.object({
    type: z.literal("tool"),
    lane: ParallelLane,
    callId: z.string(),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
    status: ToolStatus,
    result: z.string().optional(),
    /** The provider's signature for this call (Gemini 3), sent back with it when the chat is replayed to the model. */
    signature: z.string().max(20_000).optional(),
    /**
     * Set just before a call that changes something outside the chat runs (a command, a click that acts, a connected
     * app). If the app dies while it runs, a restart knows it may have happened and says so instead of offering a
     * silent retry. Saved before the call starts, so it survives a crash in the middle of it.
     */
    outward: z.boolean().optional(),
    /**
     * A file change the user can undo from the chat (write_file, edit_file): the id of the copy kept of the file as it
     * was, and whether it was undone. An undone change is replayed to the bot as undone.
     */
    undo: z.object({ id: z.string(), undone: z.boolean().optional() }).optional(),
    /** Who settled an approval: the user, a saved rule, the command policy, the group-chat rule, the clock or Stop. */
    decidedBy: z.enum(["user", "rule", "policy", "group_chat", "timeout", "stopped"]).optional(),
    /** Set while the call waits for the user's decision (drives the approval card). */
    approval: z
      .object({
        id: z.string(),
        kind: z.enum(["general", "terminal"]),
        summary: z.string(),
        badges: z.array(z.string()),
        canAlways: z.boolean(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("question"),
    questionId: z.string(),
    question: z.string(),
    /** Choices the user can tap instead of typing (2 to 6); they can always type something else. */
    options: z.array(z.string()).max(6).optional(),
    /** The choices are checkboxes: pick any number. The answer then lists the picks, one per line. */
    multiple: z.boolean().optional(),
    answer: z.string().optional(),
    /** Set when the turn ended before it was answered: the card can no longer be answered. */
    expired: z.boolean().optional(),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string(), lane: ParallelLane }),
  /** Secure secret card: the user types a value straight into the keychain; the bot only learns its name. */
  z.object({
    type: z.literal("secret"),
    requestId: z.string(),
    name: z.string(),
    reason: z.string(),
    saved: z.boolean(),
    /** Set when the turn ended before the user answered: the card can no longer be answered. */
    expired: z.boolean().optional(),
  }),
]);
export type MessagePart = z.infer<typeof MessagePart>;

export const MessageStatus = z.enum(["streaming", "done", "error", "stopped"]);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const Usage = z.object({ inputTokens: z.number(), outputTokens: z.number() });
export type Usage = z.infer<typeof Usage>;

export const Message = z.object({
  id: MessageId,
  threadId: ThreadId,
  role: z.enum(["user", "bot", "system"]),
  botId: BotId.nullable(),
  /** A discussion moderator's summary. (A bot message without a bot can also be from a deleted bot.) */
  moderator: z.boolean().default(false),
  /** A message sent in Parallel Bots mode, or the reply to one (written in three sections). */
  parallel: z.boolean().default(false),
  /** A Parallel Bots reply whose three roles each ran on their own, with tools. */
  parallelTools: z.boolean().default(false),
  parts: z.array(MessagePart),
  status: MessageStatus,
  model: z.string().nullable(),
  usage: Usage.nullable(),
  replyToId: MessageId.nullable(),
  /**
   * A bot's reply: the user's messages sent while it was being written that it took in between steps. They are saved
   * after it, so later turns are told they were answered here rather than reading them as new.
   */
  tookIn: z.array(MessageId).optional(),
  /** Emoji reactions from the user (acknowledgement only, never approval). */
  reactions: z.array(z.string()),
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof Message>;

export const Thread = z.object({
  id: ThreadId,
  kind: z.enum(["direct", "group"]),
  /** A group made with "New cluster": its bots were made for its discussion and live only there. */
  cluster: z.boolean().default(false),
  /** A cluster made with "New race": its racers work alone on one task, then its judge compiles the best. */
  race: z.boolean().default(false),
  /** A conversation two bots share for bot-to-bot messages and delegated tasks (made by the app, not the user). */
  pair: z.boolean().default(false),
  title: z.string().nullable(),
  memberIds: z.array(BotId),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Thread = z.infer<typeof Thread>;

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const SendMessageInput = z.object({
  text: z.string().max(100_000),
  images: z
    .array(
      z.object({
        mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
        // Base64 is 4 characters per 3 bytes, padded to a whole group of 4.
        data: z.string().max(4 * Math.ceil(MAX_IMAGE_BYTES / 3)),
      }),
    )
    .max(4)
    .optional(),
  replyToId: MessageId.optional(),
  /** Parallel Bots: one request, and one reply with three roles' answers in three sections. Chats with one bot only. */
  parallel: z.boolean().optional(),
  /** With `parallel`: let each of the three roles search and open pages, on its own. */
  parallelTools: z.boolean().optional(),
});
export type SendMessageInput = z.infer<typeof SendMessageInput>;

/** What a thread's bot is doing right now; drives "Waiting for model" / "Thinking…" in the UI. */
export const ThreadActivity = z.enum(["idle", "queued", "thinking", "working", "waiting_user"]);
export type ThreadActivity = z.infer<typeof ThreadActivity>;

/**
 * Whether answering this message again could do something twice: it started a call that changes things outside the
 * chat (marked `outward` before it ran), or it was cut off by a restart in the middle of one. Retrying such a reply
 * is the user's call to make by asking again, never a button.
 */
export function repeatsAction(message: Pick<Message, "parts">): boolean {
  return message.parts.some(
    (part) =>
      (part.type === "tool" && part.outward === true) ||
      (part.type === "error" && part.code === "interrupted"),
  );
}

/** Plain text of a message, for previews, search and prompts. */
export function messageText(message: Pick<Message, "parts">): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export const MAX_GROUP_MEMBERS = 6;

export const CreateGroupInput = z.object({
  title: z.string().trim().max(80).nullable().optional(),
  memberIds: z.array(BotId).min(2).max(MAX_GROUP_MEMBERS),
});
export type CreateGroupInput = z.infer<typeof CreateGroupInput>;

export const UpdateGroupInput = z
  .object({
    title: z.string().trim().max(80).nullable(),
    memberIds: z.array(BotId).min(2).max(MAX_GROUP_MEMBERS),
  })
  .partial();
export type UpdateGroupInput = z.infer<typeof UpdateGroupInput>;

export const REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;
