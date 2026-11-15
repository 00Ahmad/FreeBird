import type { JobFact, MatchLine } from "@mrog/shared";
import { describe, expect, it } from "vitest";

import {
  buildMatch,
  DEALBREAKER_CAP,
  MISSING_MUST_CAP,
  scoreLabel,
  scoreMatch,
  titleFits,
  WRONG_TITLE_CAP,
} from "./match";
import type { Requirement } from "./profile";

const REQUIREMENTS: Requirement[] = [
  { id: "r1", kind: "title", text: "The job is one of: Backend Engineer" },
  { id: "r2", kind: "salary", text: "Pays at least 55,000 GBP a year" },
  { id: "r3", kind: "must", text: "Python" },
  { id: "r4", kind: "dealbreaker", text: "Free of: on-call every week" },
  { id: "r5", kind: "nice", text: "4-day week" },
];
const facts = (salary: string | null): JobFact[] => [
  { name: "salary", value: salary, quote: salary ? `Salary ${salary}` : null },
];

describe("the match", () => {
  it("has a line per requirement; one not answered is unknown", () => {
    const lines = buildMatch(
      REQUIREMENTS,
      [{ id: "r1", verdict: "meets", reason: "Same title." }],
      facts("£60k"),
    );
    expect(lines.map((line) => line.verdict)).toEqual(["meets", "unknown", "unknown", "unknown", "unknown"]);
    expect(lines[1]!.reason).toBe("Not checked.");
  });

  it("can't claim the salary when the posting doesn't state one", () => {
    const lines = buildMatch(
      REQUIREMENTS,
      [{ id: "r2", verdict: "meets", reason: "Pays well." }],
      facts(null),
    );
    expect(lines[1]).toMatchObject({ verdict: "unknown", reason: "The posting doesn't state it." });
  });

  it("ignores verdicts that aren't verdicts", () => {
    const lines = buildMatch(REQUIREMENTS, [{ id: "r3", verdict: "absolutely", reason: "?" }], facts(null));
    expect(lines[2]!.verdict).toBe("unknown");
  });

  it("scores by weight, worked out by code", () => {
    const all = (verdict: MatchLine["verdict"]) =>
      buildMatch(
        REQUIREMENTS,
        REQUIREMENTS.map((r) => ({
          id: r.id,
          verdict: r.kind === "dealbreaker" ? "meets" : verdict,
          reason: "Said so.",
        })),
        facts("£60k"),
      );
    expect(scoreMatch(all("meets")).score).toBe(100);
    expect(scoreMatch(all("misses")).score).toBe(0);
    expect(scoreMatch(all("partly")).score).toBe(50);
  });

  it("caps a job with a deal-breaker, and one with the wrong title", () => {
    const lines = buildMatch(
      REQUIREMENTS,
      [
        { id: "r1", verdict: "meets" },
        { id: "r2", verdict: "meets" },
        { id: "r3", verdict: "meets" },
        { id: "r4", verdict: "misses", reason: "Weekly on-call rota." },
        { id: "r5", verdict: "meets" },
      ],
      facts("£60k"),
    );
    expect(scoreMatch(lines)).toEqual({ score: DEALBREAKER_CAP, dealBreaker: "on-call every week" });
    const wrongTitle = lines.map((line) =>
      line.kind === "title" ? { ...line, verdict: "misses" as const } : line,
    );
    expect(scoreMatch(wrongTitle.filter((l) => l.kind !== "dealbreaker")).score).toBe(WRONG_TITLE_CAP);
  });

  it("checks the title by code: a job titled with every word you want is that job", () => {
    expect(titleFits("Senior Backend Engineer (Python)", "Backend Engineer")).toBe(true);
    expect(titleFits("Backend Engineers", "Backend Engineer")).toBe(true);
    expect(titleFits("Senior Software Engineer", "Backend Engineer")).toBe(false);
    const requirements: Requirement[] = [
      {
        id: "r1",
        kind: "title",
        text: "Same kind of job as: Senior Backend Engineer",
        titles: ["Senior Backend Engineer"],
      },
    ];
    const titled: JobFact[] = [
      { name: "title", value: "Senior Backend Engineer", quote: "Senior Backend Engineer" },
    ];
    const lines = buildMatch(
      requirements,
      [{ id: "r1", verdict: "misses", reason: "Uses Java, not Python." }],
      titled,
    );
    expect(lines[0]).toMatchObject({ verdict: "meets", reason: "The title matches one you want." });
  });

  it("never counts a job missing a must-have as a good match", () => {
    const lines = buildMatch(
      REQUIREMENTS,
      [
        { id: "r1", verdict: "meets", reason: "Same title." },
        { id: "r2", verdict: "meets", reason: "£60k." },
        { id: "r3", verdict: "misses", reason: "Java, not Python." },
        { id: "r5", verdict: "meets", reason: "4-day week." },
      ],
      facts("£60k"),
    );
    expect(scoreMatch(lines).score).toBe(MISSING_MUST_CAP);
  });

  it("counts the wrong kind of job, or a missing must-have, only when the Checker says why", () => {
    const silent = buildMatch(
      REQUIREMENTS,
      [
        { id: "r1", verdict: "misses" },
        { id: "r3", verdict: "misses" },
      ],
      facts(null),
    );
    expect(silent[0]).toMatchObject({ verdict: "unknown", reason: "Not shown on the posting." });
    expect(silent[2]).toMatchObject({ verdict: "unknown", reason: "Not shown on the posting." });
  });

  it("counts a deal-breaker as hit only when the Checker says why", () => {
    const silent = buildMatch(REQUIREMENTS, [{ id: "r4", verdict: "misses" }], facts(null));
    expect(silent[3]).toMatchObject({ verdict: "unknown", reason: "Not shown on the posting." });
    const said = buildMatch(
      REQUIREMENTS,
      [{ id: "r4", verdict: "misses", reason: "The posting says on-call every week." }],
      facts(null),
    );
    expect(said[3]!.verdict).toBe("misses");
  });

  it("labels scores", () => {
    expect([scoreLabel(80), scoreLabel(60), scoreLabel(20)]).toEqual(["strong", "good", "weak"]);
  });
});
