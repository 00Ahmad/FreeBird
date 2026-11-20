import type { JobFact, MatchLine } from "@mrog/shared";
import { describe, expect, it } from "vitest";

import { agency } from "./agency";
import { closed } from "./closed";
import { dealBreaker } from "./deal-breaker";
import { daysSincePosted, saysClosed, warningsFor, WARNING_RULES } from "./index";
import { noSalary } from "./no-salary";
import { oldPosting } from "./old-posting";
import { scamWording } from "./scam-wording";
import type { WarningContext } from "./types";

const NOW = new Date("2026-11-14T12:00:00Z");
const context = (over: Partial<WarningContext> = {}): WarningContext => ({
  page: "A normal job posting with a salary of £50,000.",
  facts: [{ name: "salary", value: "£50,000", quote: "a salary of £50,000" }],
  match: [],
  now: NOW,
  ...over,
});
const posted = (value: string): JobFact[] => [
  { name: "posted", value, quote: value },
  { name: "salary", value: "£1", quote: "£1" },
];

describe("warning signs", () => {
  it("each has its own id, and a clean posting has none", () => {
    expect(new Set(WARNING_RULES.map((rule) => rule.id)).size).toBe(WARNING_RULES.length);
    expect(warningsFor(context())).toEqual([]);
  });

  it("an old posting", () => {
    expect(daysSincePosted("30+ days ago", NOW)).toBe(30);
    expect(daysSincePosted("Posted 2 months ago", NOW)).toBe(60);
    expect(daysSincePosted("Posted today", NOW)).toBe(0);
    expect(daysSincePosted("Posted: 2026-09-01", NOW)).toBe(74);
    expect(daysSincePosted("soonish", NOW)).toBeNull();
    // No year: this year's date, not 2001's (which made "Posted May 5" about 9,000 days old).
    expect(daysSincePosted("Posted Nov 5", NOW)).toBe(daysSincePosted("Posted: 2026-11-05", NOW));
    expect(daysSincePosted("Posted 5 November", NOW)).toBe(daysSincePosted("Posted: 2026-11-05", NOW));
    // Still to come this year: last year's.
    expect(daysSincePosted("Posted Dec 30", NOW)).toBe(daysSincePosted("2025-12-30", NOW));
    expect(daysSincePosted("1 September 2026", NOW)).toBe(daysSincePosted("2026-09-01", NOW));
    // 03/04/2026 reads as 3 April or 4 March: the newer of the two.
    expect(daysSincePosted("03/04/2026", NOW)).toBe(daysSincePosted("2026-04-03", NOW));
    expect(oldPosting.check(context({ facts: posted("2 months ago") }))).toMatch(/^Posted about 60 days ago/);
    expect(oldPosting.check(context({ facts: posted("3 weeks ago") }))).toBeNull();
  });

  it("no salary", () => {
    expect(noSalary.check(context({ facts: [] }))).toMatch(/No salary/);
  });

  it("scam wording", () => {
    expect(scamWording.check(context({ page: "You must pay a training fee before you start." }))).toMatch(
      /asks you to pay/,
    );
    expect(scamWording.check(context({ page: "The interview is held on Telegram." }))).toMatch(/chat app/);
    expect(scamWording.check(context({ page: "Be your own boss with unlimited earning!" }))).toMatch(
      /easy money/,
    );
    expect(scamWording.check(context({ page: "We offer paid training and a laptop." }))).toBeNull();
  });

  it("an agency hiding the employer", () => {
    expect(
      agency.check(context({ page: "We are recruiting on behalf of our client, a leading bank." })),
    ).toMatch(/agency/);
    expect(agency.check(context({ page: "Our clients love our product." }))).toBeNull();
  });

  it("a closed job", () => {
    expect(closed.check(context({ page: "Sorry, this job has expired." }))).toMatch(/closed/);
    expect(saysClosed("We are no longer accepting applications")).toBe(true);
    expect(saysClosed("Applications close on Friday")).toBe(false);
  });

  it("a deal-breaker", () => {
    const match: MatchLine[] = [
      {
        kind: "dealbreaker",
        requirement: "Free of: on-call every week",
        verdict: "misses",
        reason: "Weekly on-call.",
      },
    ];
    expect(dealBreaker.check(context({ match }))).toBe("Has one of your deal-breakers: on-call every week.");
  });

  it("a deal-breaker the job may have", () => {
    const match: MatchLine[] = [
      {
        kind: "dealbreaker",
        requirement: "Free of: weekly on-call",
        verdict: "partly",
        reason: "Has an on-call rotation.",
      },
    ];
    expect(dealBreaker.check(context({ match }))).toBe(
      "May have one of your deal-breakers: weekly on-call (Has an on-call rotation).",
    );
  });

  it("adds the Checker's own, clipped and at most three", () => {
    const found = warningsFor(context(), ["  A   long\nnote ", "b", "c", "d", ""]);
    expect(found).toEqual([
      { id: "checker", text: "A long note" },
      { id: "checker", text: "b" },
      { id: "checker", text: "c" },
    ]);
  });
});
