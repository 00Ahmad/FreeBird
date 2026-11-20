import type { JobCard } from "@mrog/shared";

import { buildMatch, scoreMatch, type ClaimedVerdict } from "./match";
import type { Requirement } from "./profile";
import { dealBreaker } from "./warnings/deal-breaker";

/**
 * A card checked against an older profile, brought up to date without a model: every requirement the Checker already
 * answered keeps its answer, the ones code decides (the title, a company to avoid, the workplace, the pay) are decided
 * again from the card's facts, and the score is worked out again. Requirements added since that need the Checker are
 * counted in `unchecked`, so the card can say so.
 */
export function rescoreCard(card: JobCard, requirements: readonly Requirement[]): JobCard {
  const before = new Map(card.match.map((line) => [line.requirement, line]));
  const claimed: ClaimedVerdict[] = requirements.flatMap((requirement) => {
    const line = before.get(requirement.text);
    return line ? [{ id: requirement.id, verdict: line.verdict, reason: line.reason }] : [];
  });
  // A carried-over line the app wrote stays marked as the app's, not passed off as the Checker's words.
  const match = buildMatch([...requirements], claimed, card.facts).map((line) =>
    before.get(line.requirement)?.byCode && !line.byCode ? { ...line, byCode: true } : line,
  );
  // Not answered before and not settled by code now: "unknown" until the job is read again.
  const unchecked = requirements.filter(
    (requirement, index) => !before.has(requirement.text) && match[index]!.reason === "Not checked.",
  ).length;
  const { score } = scoreMatch(match);
  // The deal-breaker warning comes from the match; the others are about the page and stay as they were.
  const warning = dealBreaker.check({ page: "", facts: card.facts, match, now: new Date() });
  const warnings = [
    ...card.warnings.filter((w) => w.id !== dealBreaker.id),
    ...(warning ? [{ id: dealBreaker.id, text: warning }] : []),
  ];
  return { ...card, match, score, warnings, unchecked };
}
