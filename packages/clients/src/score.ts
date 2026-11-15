import type { FitLine, LeadKind, LeadSignal } from "@mrog/shared";

import { scoreFit } from "./fit";
import { whyNow } from "./signals/strength";

/** A lead scores at least this to count toward the number you asked for. */
export const GOOD_LEAD = 50;
/** An excluded industry or place, or the wrong industry or place. */
export const EXCLUDED_CAP = 10;
export const WRONG_PLACE_CAP = 25;
export const WRONG_SIZE_CAP = 40;
export const MISSING_MUST_CAP = 45;
/** A quiet fit (no signs yet) never scores above this: hot leads come first. */
export const QUIET_CAP = 70;

export interface ScoreInput {
  kind: LeadKind;
  fit: FitLine[];
  signals: LeadSignal[];
  /** Traits and clues found. */
  evidence: number;
  /** Ways to reach them found. */
  contacts: number;
  /** An exclusion of yours it falls under. */
  excluded: string | null;
  now: Date;
}

export interface LeadScore {
  score: number;
  /** Why it was capped, in plain words. */
  capped: string | null;
}

/**
 * The lead score, by code. Fit counts most; the why-now strength of its signs lifts it, so a good fit with no fresh
 * sign can't be a strong lead and a strong sign at a bad fit is capped. A quiet fit is scored on fit and evidence,
 * never above QUIET_CAP. A lead with no way to reach it is kept under "good".
 */
export function scoreLead(input: ScoreInput): LeadScore {
  const fit = scoreFit(input.fit);
  let score =
    input.kind === "quiet"
      ? Math.min(QUIET_CAP, fit * 0.6 + 8 * Math.min(3, input.evidence))
      : fit * (0.45 + 0.55 * whyNow(input.signals, input.now));
  let capped: string | null = null;
  const cap = (limit: number, why: string) => {
    if (score > limit) {
      score = limit;
      capped = why;
    }
  };
  const misses = (kind: FitLine["kind"]) => input.fit.some((l) => l.kind === kind && l.verdict === "misses");
  if (input.excluded) cap(EXCLUDED_CAP, input.excluded);
  if (misses("industry")) cap(WRONG_PLACE_CAP, "Not in your clients' industry.");
  if (misses("place")) cap(WRONG_PLACE_CAP, "Not where you serve.");
  if (misses("size")) cap(WRONG_SIZE_CAP, "Not the size of client you want.");
  if (misses("must")) cap(MISSING_MUST_CAP, "Misses one of your must-haves.");
  if (input.contacts === 0) cap(GOOD_LEAD - 1, "No way to reach them was found.");
  return { score: Math.round(Math.max(0, score)), capped };
}

export const isGoodLead = (score: number) => score >= GOOD_LEAD;

export function scoreLabel(score: number): "strong" | "good" | "weak" {
  if (score >= 75) return "strong";
  if (score >= GOOD_LEAD) return "good";
  return "weak";
}

const BAND: Record<LeadKind, number> = { asking: 0, signs: 1, quiet: 2 };

/** Leads in board order: asking now, then with signs, then quiet fits; the higher score first in each. */
export const byBand = <T extends { kind: LeadKind; score: number }>(leads: readonly T[]): T[] =>
  leads.toSorted((a, b) => BAND[a.kind] - BAND[b.kind] || b.score - a.score);

export interface QuietBarInput {
  fit: FitLine[];
  evidence: number;
  /** Official records it was confirmed from. */
  records: number;
  ownSite: boolean;
}

/**
 * Whether a quiet fit clears the higher bar: a strong fit (no line misses, industry and place meet), at least one
 * trait or clue, and confirmed both from an official record and from its own site. Null when it passes, else why not.
 */
export function quietBar(input: QuietBarInput): string | null {
  if (input.fit.some((l) => l.verdict === "misses")) return "it misses part of your ideal client";
  const weak = input.fit.find((l) => (l.kind === "industry" || l.kind === "place") && l.verdict !== "meets");
  if (weak) return `its ${weak.kind} isn't confirmed`;
  if (input.records === 0) return "no official record confirms it";
  if (!input.ownSite) return "its own website wasn't found";
  if (input.evidence === 0) return "no trait or clue for your service was found";
  return null;
}
