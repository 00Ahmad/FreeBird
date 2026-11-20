import type { JobCard } from "@mrog/shared";
import { describe, expect, it } from "vitest";

import { buildMatch, scoreMatch } from "./match";
import { emptyProfile, mergeProfile, requirementsOf } from "./profile";
import { rescoreCard } from "./rescore";

const facts: JobCard["facts"] = [
  { name: "title", value: "Senior Backend Engineer", quote: "Senior Backend Engineer" },
  { name: "company", value: "Acme Robotics", quote: "Acme Robotics" },
  { name: "location", value: null, quote: null },
  { name: "workplace", value: "Hybrid", quote: "Hybrid - 2 days in the office" },
  { name: "salary", value: null, quote: null },
  { name: "seniority", value: null, quote: null },
  { name: "employment", value: null, quote: null },
  { name: "posted", value: null, quote: null },
];

function cardFor(
  profile: ReturnType<typeof emptyProfile>,
  claimed: { id: string; verdict: string; reason: string }[],
) {
  const match = buildMatch(requirementsOf(profile), claimed, facts);
  return {
    id: "c1",
    url: "https://x.example/jobs/1",
    site: "x.example",
    readBy: "text",
    foundAt: "2026-11-20T00:00:00.000Z",
    scan: 1,
    column: "found",
    facts,
    summary: "",
    match,
    score: scoreMatch(match).score,
    warnings: [],
    company: [],
    reaction: null,
    reason: null,
    unchecked: 0,
  } as JobCard;
}

describe("a card checked against an older profile", () => {
  const before = mergeProfile(emptyProfile(), { titles: ["Backend Engineer"], mustHaves: ["Python"] });
  const card = cardFor(before, [{ id: "r2", verdict: "meets", reason: "Uses Python." }]);

  it("keeps the Checker's answers and decides by code what code can", () => {
    // Now you want remote work and avoid Acme: both settled from the card's facts, no model needed.
    const after = mergeProfile(before, { workplace: ["remote"], avoidCompanies: ["Acme"] });
    const updated = rescoreCard(card, requirementsOf(after));
    expect(updated.match.find((l) => l.requirement === "Python")).toMatchObject({
      verdict: "meets",
      reason: "Uses Python.",
    });
    expect(updated.match.find((l) => l.kind === "workplace")?.verdict).toBe("misses");
    expect(updated.match.find((l) => l.requirement === "Not at Acme")?.verdict).toBe("misses");
    expect(updated.score).toBeLessThanOrEqual(10);
    expect(updated.warnings.map((w) => w.id)).toContain("deal-breaker");
    expect(updated.unchecked).toBe(0);
  });

  it("counts a new requirement only reading the job again could check", () => {
    const after = mergeProfile(before, { mustHaves: ["Python", "Kubernetes"] });
    const updated = rescoreCard(card, requirementsOf(after));
    expect(updated.unchecked).toBe(1);
    expect(updated.match.find((l) => l.requirement === "Kubernetes")?.verdict).toBe("unknown");
  });
});
