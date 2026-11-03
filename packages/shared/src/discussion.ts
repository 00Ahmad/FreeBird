import { z } from "zod";

import { AvatarColor, BotName } from "./bots";
import { BotId, MessageId, ThreadId } from "./ids";
import { ModelRef } from "./models";

/** What a group discussion is for; shapes the bots' instructions and the final summary. */
export const DiscussionGoal = z.enum(["explore", "decide", "research"]);
export type DiscussionGoal = z.infer<typeof DiscussionGoal>;

export const DISCUSSION_GOALS: Record<DiscussionGoal, { label: string; description: string }> = {
  explore: {
    label: "Explore ideas",
    description: "Come up with options and stress-test them: the most promising ideas and their weak spots.",
  },
  decide: {
    label: "Reach a decision",
    description: "Weigh the options against the evidence and end with one clear recommendation.",
  },
  research: {
    label: "Research a question",
    description:
      "Find out what is true from good sources, check each other's sources and flag what's uncertain.",
  },
};

export const MAX_DISCUSSION_ROUNDS = 6;

export const DiscussionStatus = z.enum(["running", "summarizing", "done", "stopped", "error"]);
export type DiscussionStatus = z.infer<typeof DiscussionStatus>;

/** A group chat's current (or last) discussion: bots take turns on a topic, then a moderator sums it up. */
export const Discussion = z.object({
  threadId: ThreadId,
  topic: z.string(),
  goal: DiscussionGoal,
  rounds: z.number().int(),
  /** Each bot's role or stance, by bot id. */
  roles: z.record(z.string(), z.string()),
  /** 1-based; 0 before the first turn. */
  round: z.number().int(),
  speakerId: BotId.nullable(),
  /** Bots that have had their turn in the current round. */
  spoken: z.array(BotId).default([]),
  status: DiscussionStatus,
  /** Waiting for the user before the next turn (Pause, or after a step). */
  paused: z.boolean().default(false),
  error: z.string().nullable(),
  summaryId: MessageId.nullable(),
  startedAt: z.iso.datetime(),
});
export type Discussion = z.infer<typeof Discussion>;

const Topic = z.string().trim().min(3, "Give the discussion a topic.").max(4000);

export const StartDiscussionInput = z.object({
  topic: Topic,
  goal: DiscussionGoal,
  rounds: z.number().int().min(1).max(MAX_DISCUSSION_ROUNDS),
  /** Roles left out or empty are suggested from the topic when the discussion starts. */
  roles: z.record(z.string(), z.string().trim().max(300)).default({}),
});
export type StartDiscussionInput = z.infer<typeof StartDiscussionInput>;

/** pause / resume: hold before the next turn; step: run one turn, then hold; finish: summarize after this turn. */
export const DiscussionControl = z.object({ action: z.enum(["pause", "resume", "step", "finish"]) });
export type DiscussionControl = z.infer<typeof DiscussionControl>;

export const SuggestRolesInput = z.object({ topic: Topic, goal: DiscussionGoal });
export type SuggestRolesInput = z.infer<typeof SuggestRolesInput>;

export const MIN_CLUSTER = 3;
export const MAX_CLUSTER = 5;

/** One expert in a cluster: made for the topic, lives only in its cluster. */
export const ClusterMember = z.object({
  name: BotName,
  /** A few words, shown under the bot: "Cloud cost analyst". */
  expertise: z.string().trim().min(1, "Give each expert an expertise.").max(80),
  /** How they think and their point of view on the topic. */
  personality: z.string().trim().min(1, "Give each expert a personality.").max(1500),
  color: AvatarColor.optional(),
  /** The model this expert runs on; null or left out: the shared model. */
  model: ModelRef.nullable().optional(),
});
export type ClusterMember = z.infer<typeof ClusterMember>;

export const ProposeClusterInput = z.object({ topic: Topic, goal: DiscussionGoal });
export type ProposeClusterInput = z.infer<typeof ProposeClusterInput>;

export const CreateClusterInput = z.object({
  topic: Topic,
  goal: DiscussionGoal,
  rounds: z.number().int().min(1).max(MAX_DISCUSSION_ROUNDS),
  title: z.string().trim().max(80).nullable().optional(),
  members: z.array(ClusterMember).min(MIN_CLUSTER).max(MAX_CLUSTER),
});
export type CreateClusterInput = z.infer<typeof CreateClusterInput>;
