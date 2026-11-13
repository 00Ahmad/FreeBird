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

export interface Attention {
  status: AttentionStatus;
  /** The sentence for a desktop notification. */
  body: string;
}

/**
 * Whether an update to a project is news for the user: it has just reached a status that needs them. `before` is the
 * status last known (undefined when nothing is). Staying in the same status is not news.
 */
export function attentionFor(
  before: CodingStatus | undefined,
  project: Pick<CodingProject, "botId" | "status" | "round" | "startedAt">,
): Attention | null {
  const { status } = project;
  if (!needsAttention(status) || before === status) return null;
  return {
    status,
    body: ATTENTION[status].body,
  };
}
