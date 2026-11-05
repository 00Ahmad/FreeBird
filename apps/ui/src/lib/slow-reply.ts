/**
 * When a reply that has not started is worth saying something about, and what.
 *
 * A local model loads and reads the whole conversation before its first word, which can take over a minute every
 * time it has been out of memory, so the same wait means "loading" there and "something is wrong" in the cloud.
 * Offering Try again too early restarts a load that was getting somewhere.
 */

export const SLOW = {
  /** Anything is said after this long without a first word. */
  noteAfterMs: 20_000,
  /** Try again / Switch model are offered after this long: sooner for a cloud model. */
  actionsAfterMs: { cloud: 20_000, local: 90_000 },
} as const;

export type SlowStage = "none" | "note" | "actions";

interface Input {
  /** Since the reply's message was created. */
  elapsedMs: number;
  /** The model runs on this computer. */
  local: boolean;
  /** Waiting for the shared model behind other work: restarting would not get it a turn any sooner. */
  queued: boolean;
  /** "Keep waiting" was pressed. */
  dismissed: boolean;
}

export function slowStage({ elapsedMs, local, queued, dismissed }: Input): SlowStage {
  if (queued || dismissed || elapsedMs < SLOW.noteAfterMs) return "none";
  return elapsedMs >= SLOW.actionsAfterMs[local ? "local" : "cloud"] ? "actions" : "note";
}

/** Milliseconds until the stage can next change, to schedule one re-check; null when it won't change by itself. */
export function nextStageIn({ elapsedMs, local, queued, dismissed }: Input): number | null {
  if (queued || dismissed) return null;
  const marks = [SLOW.noteAfterMs, SLOW.actionsAfterMs[local ? "local" : "cloud"]].filter(
    (mark) => mark > elapsedMs,
  );
  return marks.length > 0 ? Math.min(...marks) - elapsedMs : null;
}
