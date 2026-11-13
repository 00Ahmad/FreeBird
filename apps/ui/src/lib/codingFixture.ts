import type {
  CardComment,
  CodingCard,
  CodingColumn,
  CodingEdge,
  CodingNode,
  CodingProject,
} from "@mrog/shared";

/** Small builders for the tests of the Coding panel's pure functions. */

export const node = (id: string, path = `src/${id}.ts`, purpose = `Does the ${id} work`): CodingNode => ({
  id,
  path,
  purpose,
});

export const edge = (id: string, files: string[], description = `Links ${files.join(", ")}`): CodingEdge => ({
  id,
  files,
  description,
});

export const comment = (
  author: CardComment["author"],
  text: string,
  at = "2026-01-01T10:00:00.000Z",
  round = 1,
): CardComment => ({ author, text, round, at });

export const fileCard = (
  ref: string,
  column: CodingColumn = "todo",
  comments: CardComment[] = [],
): CodingCard => ({ id: `card-${ref}`, kind: "file", ref, title: `Write ${ref}`, column, comments });

export const connectorCard = (
  ref: string,
  column: CodingColumn = "todo",
  comments: CardComment[] = [],
): CodingCard => ({ id: `card-${ref}`, kind: "connector", ref, title: `Connect ${ref}`, column, comments });

/** A whole project with sensible defaults. */
export const project = (over: Partial<CodingProject> = {}): CodingProject => ({
  botId: "bot-coder",
  status: "developing",
  outputFolder: "C:\\Projects\\app",
  roles: {
    planner: { botId: "bot-planner", model: null },
    developer: { botId: "bot-developer", model: null },
    qa: { botId: "bot-qa", model: null },
  },
  autoApprove: false,
  maxRounds: 5,
  round: 0,
  brief: "Build an app",
  nodes: [],
  edges: [],
  cards: [],
  note: null,
  error: null,
  startedAt: "2026-01-01T09:00:00.000Z",
  ...over,
});

type Work = NonNullable<CodingCard["work"]>;

/** A card's time and tokens, finished turns only; override what a test cares about. */
export const work = (over: Partial<Work> = {}): Work => ({
  startedAt: "2026-01-01T09:00:00.000Z",
  seconds: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  ...over,
});

/** The same card with its work filled in. */
export const withWork = (card: CodingCard, over: Partial<Work>): CodingCard => ({
  ...card,
  work: work(over),
});
