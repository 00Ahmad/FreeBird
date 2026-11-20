import { isClosedPosting, judge, saysClosed, sourceFor } from "@mrog/jobs";
import type { JobProject, JobReader } from "@mrog/shared";

import type { Phase } from "./phase";
import type { PageReader } from "./readers/types";
import type { JobState } from "./state";

/** Jobs checked in one go: the ones you're most likely to act on. */
export const MAX_CHECKED = 40;
/** The columns checked: jobs you haven't applied for yet. */
const CHECKED_COLUMNS = new Set(["found", "shortlisted"]);

export const CLOSED_WARNING = "closed";

/**
 * Whether the jobs on the board are still open: each Found and Shortlisted job's page read again, the cheap way (a job
 * system's own list, or the page as text), with no model. A page that is gone, or says the job is closed, gets the
 * "closed" warning. Only ever when you ask: a Job Bot never searches or reads on its own.
 */
export async function checkStillOpen(deps: {
  state: JobState;
  botId: string;
  readers: Partial<Record<Exclude<JobReader, "you">, PageReader>>;
  signal: AbortSignal;
  phase: Phase;
}): Promise<{ checked: number; closed: number; unreadable: number }> {
  const { state, botId, readers, signal, phase } = deps;
  const cards = state
    .need(botId)
    .cards.filter((card) => CHECKED_COLUMNS.has(card.column))
    .slice(0, MAX_CHECKED);
  let closed = 0;
  let unreadable = 0;
  for (const [index, card] of cards.entries()) {
    if (signal.aborted) break;
    phase.say(`Checking ${index + 1} of ${cards.length}: ${card.site}…`);
    const reader = sourceFor(card.url) && readers.api ? readers.api : readers.text;
    let gone = false;
    let says = false;
    try {
      const page = reader ? await reader.read(card.url, { botId, signal, phase, why: "" }) : null;
      if (!page) {
        unreadable += 1;
        continue;
      }
      const verdict = judge(page);
      gone = verdict.kind === "gone";
      says = verdict.kind === "ok" && (isClosedPosting(page) || saysClosed(page.text));
      if (!gone && verdict.kind !== "ok") unreadable += 1;
    } catch {
      if (signal.aborted) break;
      unreadable += 1;
      continue;
    }
    if (!gone && !says) continue;
    closed += 1;
    const on = new Date().toISOString().slice(0, 10);
    state.change(botId, (p: JobProject) => {
      const live = p.cards.find((c) => c.id === card.id);
      if (!live) return;
      live.warnings = [
        ...live.warnings.filter((w) => w.id !== CLOSED_WARNING),
        {
          id: CLOSED_WARNING,
          text: gone
            ? `The posting is gone (checked ${on}): the job has probably closed.`
            : `The page says this job is closed (checked ${on}).`,
        },
      ];
    });
  }
  return { checked: cards.length, closed, unreadable };
}
