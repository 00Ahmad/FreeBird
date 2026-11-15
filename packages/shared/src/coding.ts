import { z } from "zod";

import { BotName } from "./bots";
import { BotId } from "./ids";
import { ModelRef } from "./models";

/** A Coding Bot is a team of three roles that plan, write and check a project in an output folder. */
export const CODING_ROLES = ["planner", "developer", "qa"] as const;
export const CodingRole = z.enum(CODING_ROLES);
export type CodingRole = z.infer<typeof CodingRole>;

export const DEFAULT_MAX_ROUNDS = 5;
export const MAX_ROUNDS_LIMIT = 20;
/** More files than this is a plan nobody can review; the planner is asked to trim it. */
export const MAX_PLAN_FILES = 40;
export const MAX_PLAN_EDGES = 80;
/** How many lines of activity a project keeps. */
export const MAX_CODING_LOG = 50;

export const CodingStatus = z.enum([
  /** Created, waiting for the brief (your first message). */
  "setup",
  /** The planner is drawing the files and connections. */
  "planning",
  /** The plan is ready and waiting for you (skipped with auto-approve). */
  "awaiting_approval",
  /** The developer is writing cards one at a time. */
  "developing",
  /** QA is reviewing the cards in the QA column. */
  "qa",
  /** The round limit was reached; it is waiting for you to raise it or step in. */
  "needs_you",
  "done",
  "stopped",
  "error",
]);
export type CodingStatus = z.infer<typeof CodingStatus>;

export const CodingColumn = z.enum(["todo", "in_progress", "qa", "done"]);
export type CodingColumn = z.infer<typeof CodingColumn>;

/** A file in the plan and what the code in it should do. */
export const CodingNode = z.object({
  id: z.string(),
  /** Relative to the output folder, with forward slashes. */
  path: z.string(),
  purpose: z.string(),
});
export type CodingNode = z.infer<typeof CodingNode>;

/** A connection between files (two or more, however many the planner decides) and what connects them. */
export const CodingEdge = z.object({
  id: z.string(),
  /** Node ids. */
  files: z.array(z.string()).min(2),
  description: z.string(),
});
export type CodingEdge = z.infer<typeof CodingEdge>;

export const CardComment = z.object({
  author: z.enum(["planner", "developer", "qa", "user"]),
  text: z.string(),
  /**
   * What the comment is: QA failing or passing the card, an automatic note that the card is back in QA because a file
   * it depends on changed, a finding of the automatic whole-project check, or a plain note (the Developer's, yours).
   * Missing on comments written before this existed.
   */
  kind: z.enum(["fail", "pass", "requeue", "check", "note"]).optional(),
  /** The QA round it was written in (0 before the first). */
  round: z.number().int().min(0),
  at: z.iso.datetime(),
});
export type CardComment = z.infer<typeof CardComment>;

/** How long a card has taken and what it cost, summed over every Developer and QA turn spent on it. */
export const CardWork = z.object({
  /** When the card first went In progress; null until it has. */
  startedAt: z.iso.datetime().nullable(),
  /** Seconds spent in finished turns (the screen adds the time of a turn still running). */
  seconds: z.number().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** How many Developer and QA turns it took. */
  turns: z.number().int().min(0),
});
export type CardWork = z.infer<typeof CardWork>;

/** A card that has taken longer than this (10 minutes) is flagged as slow. */
export const SLOW_CARD_SECONDS = 600;

/** One thing on the progress board: a file to write, or a connection to make work. */
export const CodingCard = z.object({
  id: z.string(),
  kind: z.enum(["file", "connector"]),
  /** The node or edge id this card is about. */
  ref: z.string(),
  title: z.string(),
  column: CodingColumn,
  comments: z.array(CardComment),
  /** Time and tokens spent on it so far; missing on cards made before this was tracked. */
  work: CardWork.optional(),
});
export type CodingCard = z.infer<typeof CodingCard>;

/** A role bot: which bot plays it and the model it runs on (null: the shared model). */
export const CodingRoleSeat = z.object({ botId: BotId, model: ModelRef.nullable() });
export type CodingRoleSeat = z.infer<typeof CodingRoleSeat>;

export const CodingProject = z.object({
  /** The Coding Bot. */
  botId: BotId,
  status: CodingStatus,
  /** An absolute path; every file the team writes goes here. */
  outputFolder: z.string(),
  roles: z.object({ planner: CodingRoleSeat, developer: CodingRoleSeat, qa: CodingRoleSeat }),
  /** Skip the wait for your approval of the plan. */
  autoApprove: z.boolean(),
  maxRounds: z.number().int().min(1).max(MAX_ROUNDS_LIMIT),
  /** QA rounds used so far. */
  round: z.number().int().min(0),
  /** What you asked for. */
  brief: z.string(),
  /** Files in the order the planner chose to build them. */
  nodes: z.array(CodingNode),
  edges: z.array(CodingEdge),
  cards: z.array(CodingCard),
  /** One line about what is happening now, shown above the board. */
  note: z.string().nullable(),
  /** Who is working right now and on which card, so the screen can light it up. Null when nobody is. */
  active: z
    .object({ role: CodingRole, cardId: z.string().nullable(), since: z.iso.datetime().optional() })
    .nullable()
    .optional(),
  /** The most recent things that happened, oldest first, kept to the last MAX_CODING_LOG. */
  log: z
    .array(z.object({ at: z.iso.datetime(), text: z.string() }))
    .max(50)
    .optional(),
  error: z.string().nullable(),
  startedAt: z.iso.datetime(),
});
export type CodingProject = z.infer<typeof CodingProject>;

const RoleModel = z.object({ model: ModelRef.nullable().optional() });

export const CreateCodingBotInput = z.object({
  name: BotName,
  /** Where the project files go. Checked by the server (it must be a safe, writable folder). */
  outputFolder: z.string().trim().min(1, "Choose an output folder.").max(500),
  roles: z.object({ planner: RoleModel, developer: RoleModel, qa: RoleModel }),
  autoApprove: z.boolean().optional(),
  maxRounds: z.number().int().min(1).max(MAX_ROUNDS_LIMIT).optional(),
});
export type CreateCodingBotInput = z.infer<typeof CreateCodingBotInput>;

export const UpdateCodingSettingsInput = z.object({
  autoApprove: z.boolean().optional(),
  maxRounds: z.number().int().min(1).max(MAX_ROUNDS_LIMIT).optional(),
  roles: z.object({ planner: RoleModel, developer: RoleModel, qa: RoleModel }).partial().optional(),
});
export type UpdateCodingSettingsInput = z.infer<typeof UpdateCodingSettingsInput>;

/** What you say when you ask the planner for changes to a plan that is waiting for approval. */
export const ReviseCodingInput = z.object({
  note: z.string().trim().min(1, "Say what to change.").max(4000),
});
export type ReviseCodingInput = z.infer<typeof ReviseCodingInput>;

/** The columns in board order. */
export const CODING_COLUMNS = CodingColumn.options;

/** A project is working while one of these is its status. */
export const isCodingBusy = (status: CodingStatus) =>
  status === "planning" || status === "developing" || status === "qa";
