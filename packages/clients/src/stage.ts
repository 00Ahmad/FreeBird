import type { CompanyStage, FitLine, LeadSignal } from "@mrog/shared";

import { daysSince } from "./dates";
import { signalStrength } from "./signals/strength";

/**
 * A company's stage (new, growing, established), decided by code where the evidence says (6.2): an official record's
 * incorporation date for new and established, a fresh sign of growth for growing. Where neither says, the Checker's
 * verdict stands, as before.
 */

/** Up to this old, a company is new. */
export const NEW_YEARS = 2;
/** From this old, a company is established. */
export const ESTABLISHED_YEARS = 5;

const GROWTH: readonly string[] = ["hiring", "first_hire", "expanding", "growing", "funding"];

export interface StageEvidence {
  /** When an official record says it was incorporated (yyyy-mm-dd). */
  incorporated: string | null;
  signals: readonly LeadSignal[];
  now: Date;
}

/** The stage line's verdict and reason from the evidence, or null when it doesn't settle it. */
export function stageVerdict(
  stages: readonly CompanyStage[],
  evidence: StageEvidence,
): Pick<FitLine, "verdict" | "reason"> | null {
  if (stages.length === 0) return null;
  const years = evidence.incorporated ? daysSince(evidence.incorporated, evidence.now) / 365.25 : null;
  const growing = evidence.signals.some(
    (s) => GROWTH.includes(s.kind) && signalStrength(s, evidence.now) > 0,
  );
  if (stages.includes("growing") && growing)
    return { verdict: "meets", reason: "It shows a fresh sign of growth." };
  if (years === null) return null;
  const age = years < 1 ? "under a year" : `${Math.floor(years)} year${Math.floor(years) === 1 ? "" : "s"}`;
  const isNew = years <= NEW_YEARS;
  const established = years >= ESTABLISHED_YEARS;
  if (stages.includes("new") && isNew) return { verdict: "meets", reason: `Incorporated ${age} ago.` };
  if (stages.includes("established") && established)
    return { verdict: "meets", reason: `Incorporated ${age} ago.` };
  // Only "new" wanted and it's well established, or only "established" and it's new: settled the other way.
  if (!stages.includes("growing") && (isNew || established))
    return { verdict: "misses", reason: `Incorporated ${age} ago: not ${stages.join(" or ")}.` };
  return null;
}
