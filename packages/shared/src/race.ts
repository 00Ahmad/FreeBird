import { z } from "zod";

import { BotName } from "./bots";
import { BotId, MessageId, ThreadId } from "./ids";
import { ModelRef } from "./models";

export const MIN_RACERS = 3;
export const MAX_RACERS = 5;

export const RacerStatus = z.enum(["waiting", "running", "done", "error", "stopped"]);
export type RacerStatus = z.infer<typeof RacerStatus>;

/** One racer's progress: it works alone, in its own thread, on the race's task. */
export const Racer = z.object({
  botId: BotId,
  status: RacerStatus,
  /** Its answer, in its own thread. */
  messageId: MessageId.nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type Racer = z.infer<typeof Racer>;

export const RaceStatus = z.enum(["racing", "judging", "done", "stopped", "error"]);
export type RaceStatus = z.infer<typeof RaceStatus>;

/** A race: 3–5 bots do the same task independently, then a judge scores them and compiles the best result. */
export const Race = z.object({
  threadId: ThreadId,
  task: z.string(),
  racers: z.array(Racer),
  judgeId: BotId,
  status: RaceStatus,
  /** The judge's scores and compiled result, in the race's thread. */
  reportId: MessageId.nullable(),
  winnerId: BotId.nullable(),
  error: z.string().nullable(),
  startedAt: z.iso.datetime(),
});
export type Race = z.infer<typeof Race>;

/** A racer to make: its name and the model it runs on (null: the shared model). */
export const RaceEntrant = z.object({ name: BotName, model: ModelRef.nullable().optional() });
export type RaceEntrant = z.infer<typeof RaceEntrant>;

export const CreateRaceInput = z.object({
  task: z.string().trim().min(3, "Give the racers a task.").max(8000),
  racers: z.array(RaceEntrant).min(MIN_RACERS).max(MAX_RACERS),
  judge: z.object({ model: ModelRef.nullable().optional() }),
  title: z.string().trim().max(80).nullable().optional(),
});
export type CreateRaceInput = z.infer<typeof CreateRaceInput>;
