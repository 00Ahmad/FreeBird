import type { CodingProject, CodingStatus } from "@mrog/shared";

/** The statuses where the project is waiting for the user, or has something to tell them. */
const ATTENTION = {
  awaiting_approval: { badge: "Approve the plan", body: "The plan is ready: approve it or ask for changes." },
  needs_you: {
    badge: "Needs you",
    body: "The round limit was reached. Raise it or tell the bot what to change.",
  },
  done: { badge: "Finished", body: "The project is finished: every card passed QA." },
  error: { badge: "Error", body: "The project stopped with an error." },
} as const satisfies Partial<Record<CodingStatus, { badge: string; body: string }>>;

type AttentionStatus = keyof typeof ATTENTION;

export const needsAttention = (status: CodingStatus): status is AttentionStatus => status in ATTENTION;

/** A short label for the sidebar row, or null when the project doesn't need the user. */
export const attentionBadge = (status: CodingStatus | undefined): string | null =>
  status && needsAttention(status) ? ATTENTION[status].badge : null;

/** News that is told once: after the user has looked at the chat, it is no longer waiting for them. */
const TOLD_ONCE: ReadonlySet<CodingStatus> = new Set(["done", "error"]);

type Seeable = Pick<CodingProject, "status" | "startedAt" | "log">;

/**
 * Which time the project reached its status: the server writes a log line when it finishes or fails, so the last
 * line's time (the server's clock) tells one "finished" from the next. A project without a log uses its start.
 */
export const attentionMark = (project: Seeable): string =>
  `${project.status}@${project.log?.at(-1)?.at ?? project.startedAt}`;

/** Whether seeing the chat now should clear the row's badge: only for news told once. */
export const canSee = (project: Pick<CodingProject, "status">): boolean => TOLD_ONCE.has(project.status);

/**
 * The sidebar badge, given the mark remembered when the user last opened the chat. "Finished" and "Error" go once
 * the chat has been opened since; "Approve the plan" and "Needs you" stay until the project moves on.
 */
export function shownAttention(project: Seeable | undefined, seen: string | undefined): string | null {
  if (!project) return null;
  const badge = attentionBadge(project.status);
  if (!badge) return null;
  return canSee(project) && seen === attentionMark(project) ? null : badge;
}

export interface Attention {
  status: AttentionStatus;
  /** The sentence for a desktop notification. */
  body: string;
}

/**
 * Whether an update to a project is news for the user: it has just reached a status that needs them. `before` is the
 * status last known (undefined when nothing is). Staying in the same status is not news, and nor is a status first
 * heard of without one before it: after a reload the first update may land before the project is fetched, and the
 * wait it reports was most likely told already.
 */
export function attentionFor(
  before: CodingStatus | undefined,
  project: Pick<CodingProject, "botId" | "status" | "round" | "startedAt">,
): Attention | null {
  const { status } = project;
  if (before === undefined || !needsAttention(status) || before === status) return null;
  return {
    status,
    body: ATTENTION[status].body,
  };
}
