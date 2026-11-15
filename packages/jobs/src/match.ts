import { MatchVerdict, type JobFact, type MatchLine, type RequirementKind } from "@mrog/shared";

import type { Requirement } from "./profile";
import { factValue } from "./source-check";
import { clip, words } from "./text";

/**
 * The match: one line per requirement with the Checker's verdict and reason, and a score worked out by code (never
 * by the model) from those lines.
 */

export interface ClaimedVerdict {
  id: string;
  verdict?: string;
  reason?: string;
}

const WEIGHTS: Record<Exclude<RequirementKind, "dealbreaker">, number> = {
  title: 3,
  workplace: 2,
  place: 2,
  salary: 2,
  must: 2,
  nice: 1,
};
const POINTS: Record<MatchVerdict, number> = { meets: 1, partly: 0.5, unknown: 0.3, misses: 0 };

const stem = (word: string) => (word.length > 3 ? word.replace(/(es|s)$/, "") : word);

/** Whether a job's title has every word of a title you want ("Senior Backend Engineer (Python)" fits "Backend Engineer"). */
export function titleFits(jobTitle: string, wanted: string): boolean {
  const need = words(wanted).map(stem);
  if (need.length === 0) return false;
  const have = new Set(words(jobTitle).map(stem));
  return need.every((word) => have.has(word));
}

/** The facts a verdict can't do without: with the fact "not stated", the verdict is "unknown" whatever was claimed. */
const NEEDS_FACT: Partial<Record<RequirementKind, JobFact["name"]>> = { salary: "salary" };

/** One line per requirement, in the requirements' order; one the Checker didn't answer is "unknown". */
export function buildMatch(
  requirements: Requirement[],
  claimed: ClaimedVerdict[],
  facts: JobFact[],
): MatchLine[] {
  const byId = new Map(claimed.map((item) => [item.id, item]));
  return requirements.map((requirement) => {
    const answer = byId.get(requirement.id);
    const parsed = MatchVerdict.safeParse(answer?.verdict);
    let verdict: MatchVerdict = parsed.success ? parsed.data : "unknown";
    let reason = clip(answer?.reason ?? "", 240) || (parsed.success ? "" : "Not checked.");
    const needed = NEEDS_FACT[requirement.kind];
    if (needed && factValue(facts, needed) === null && verdict !== "unknown") {
      verdict = "unknown";
      reason = "The posting doesn't state it.";
    }
    // The title is checked by code when it can be: a job whose quoted title has every word of a title you want is that
    // job, whatever the model said (a 9B model marked "Senior Backend Engineer" wrong for using Java, not Python).
    const jobTitle = factValue(facts, "title");
    if (
      requirement.kind === "title" &&
      jobTitle &&
      requirement.titles?.some((title) => titleFits(jobTitle, title))
    ) {
      verdict = "meets";
      reason = "The title matches one you want.";
    }
    // A deal-breaker or the wrong kind of job caps the score, so such a verdict must say why: a small model sometimes
    // gives one with no reason at all (misreading "Free of …", or comparing titles word for word).
    if (
      (requirement.kind === "dealbreaker" || requirement.kind === "title" || requirement.kind === "must") &&
      verdict === "misses" &&
      !reason
    ) {
      verdict = "unknown";
      reason = "Not shown on the posting.";
    }
    return { kind: requirement.kind, requirement: requirement.text, verdict, reason };
  });
}

/** A job that has one of your deal-breakers, or isn't the job you want, can't score above these. */
export const DEALBREAKER_CAP = 10;
export const WRONG_TITLE_CAP = 25;
/** A job missing one of your must-haves is never a good match. */
export const MISSING_MUST_CAP = 45;

/** The score from 0 to 100, and the deal-breaker the job has, if any. */
export function scoreMatch(lines: MatchLine[]): { score: number; dealBreaker: string | null } {
  let total = 0;
  let got = 0;
  for (const line of lines) {
    if (line.kind === "dealbreaker") continue;
    const weight = WEIGHTS[line.kind];
    total += weight;
    got += weight * POINTS[line.verdict];
  }
  let score = total === 0 ? 50 : Math.round((got / total) * 100);
  const broken = lines.find((line) => line.kind === "dealbreaker" && line.verdict === "misses");
  if (broken) score = Math.min(score, DEALBREAKER_CAP);
  if (lines.some((line) => line.kind === "title" && line.verdict === "misses"))
    score = Math.min(score, WRONG_TITLE_CAP);
  if (lines.some((line) => line.kind === "must" && line.verdict === "misses" && line.reason))
    score = Math.min(score, MISSING_MUST_CAP);
  return {
    score,
    dealBreaker: broken ? broken.requirement.replace(/^(Free of|Not in the|Not at):?\s*/i, "") : null,
  };
}

/** A job scoring at least this is a match: it counts toward the number of new jobs a scan was asked for. */
export const GOOD_MATCH = 50;
export const isGoodMatch = (score: number) => score >= GOOD_MATCH;

/** How the score reads on a card. */
export function scoreLabel(score: number): "strong" | "good" | "weak" {
  return score >= 75 ? "strong" : isGoodMatch(score) ? "good" : "weak";
}
