import { z } from "zod";

import { Bot } from "./bots";
import { Discussion } from "./discussion";
import { Race } from "./race";
import { BotId, EventId, MessageId, ThreadId } from "./ids";
import { Message, Thread, ThreadActivity } from "./messages";
import { RuntimeStatus } from "./models";

const base = { id: EventId, at: z.iso.datetime() };

/** Every event the harness streams to the UI over SSE. */
export const HarnessEvent = z.discriminatedUnion("type", [
  /** Sent first on every new stream connection. */
  z.object({ ...base, type: z.literal("stream.hello"), version: z.string(), startedAt: z.iso.datetime() }),
  /** The stream could not replay what a reconnecting client missed: refetch all state. */
  z.object({ ...base, type: z.literal("stream.resync") }),
  z.object({ ...base, type: z.literal("heartbeat") }),
  z.object({ ...base, type: z.literal("bot.created"), bot: Bot }),
  z.object({ ...base, type: z.literal("bot.updated"), bot: Bot }),
  z.object({ ...base, type: z.literal("bot.deleted"), botId: BotId }),
  z.object({ ...base, type: z.literal("secrets.changed"), names: z.array(z.string()) }),
  z.object({ ...base, type: z.literal("thread.created"), thread: Thread }),
  z.object({ ...base, type: z.literal("thread.updated"), thread: Thread }),
  z.object({ ...base, type: z.literal("thread.deleted"), threadId: ThreadId }),
  z.object({ ...base, type: z.literal("message.created"), message: Message }),
  z.object({ ...base, type: z.literal("message.updated"), message: Message }),
  /** Streamed text appended to one part of a message; ephemeral, the final text arrives in message.updated. */
  z.object({
    ...base,
    type: z.literal("message.delta"),
    threadId: ThreadId,
    messageId: MessageId,
    partIndex: z.number().int(),
    kind: z.enum(["text", "reasoning"]),
    text: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("thread.activity"),
    threadId: ThreadId,
    botId: BotId.nullable(),
    activity: ThreadActivity,
  }),
  z.object({ ...base, type: z.literal("runtime.status"), status: RuntimeStatus }),
  z.object({
    ...base,
    type: z.literal("runtime.pull"),
    model: z.string(),
    status: z.string(),
    completed: z.number().nullable(),
    total: z.number().nullable(),
    done: z.boolean(),
    error: z.string().nullable(),
  }),
  /** A group discussion started, moved to the next speaker or round, or ended. */
  z.object({ ...base, type: z.literal("discussion.updated"), discussion: Discussion }),
  /** A race started, a racer finished, the judge started, or it ended. */
  z.object({ ...base, type: z.literal("race.updated"), race: Race }),
  /** Something changed in a collection the UI caches; refetch it. */
  z.object({
    ...base,
    type: z.literal("data.changed"),
    keys: z.array(z.string()),
    /** Set when only one thread's data changed (e.g. its chat was cleared). */
    threadId: ThreadId.optional(),
  }),
]);
export type HarnessEvent = z.infer<typeof HarnessEvent>;
export type HarnessEventType = HarnessEvent["type"];

/** An event before the bus stamps its id and time. */
export type HarnessEventInput = HarnessEvent extends infer E
  ? E extends HarnessEvent
    ? Omit<E, "id" | "at">
    : never
  : never;

/** Never stored for replay after a reconnect, and sent without an SSE id. */
export const EPHEMERAL_EVENTS: ReadonlySet<HarnessEventType> = new Set([
  "stream.hello",
  "stream.resync",
  "heartbeat",
  "message.delta",
  "thread.activity",
  "runtime.status",
  "runtime.pull",
]);
