import type { FitLine, LeadSignal } from "@mrog/shared";
import { describe, expect, it } from "vitest";

import { daysBefore } from "./dates";
import { buildFit, excludedBy, scoreFit } from "./fit";
import { emptyOffer, mergeOffer, requirementsOf } from "./profile";
import { byBand, GOOD_LEAD, isGoodLead, QUIET_CAP, quietBar, scoreLead, WRONG_SIZE_CAP } from "./score";

const NOW = new Date("2026-11-14T12:00:00Z");
const profile = mergeOffer(emptyOffer(), {
  offer: "Payroll",
  areas: ["Leeds"],
  industries: ["restaurants"],
  sizeMin: 5,
  sizeMax: 50,
});
const facts = (over: Record<string, string>) =>
  (["company", "website", "place", "size", "industry", "what"] as const).map((name) => ({
    name,
    value: over[name] ?? null,
    quote: over[name] ?? null,
  }));
const line = (kind: FitLine["kind"], verdict: FitLine["verdict"]): FitLine => ({
  kind,
  requirement: kind,
  verdict,
  reason: "r",
});
const sign = (kind: LeadSignal["kind"], age: number): LeadSignal => ({
  kind,
  quote: "q",
  url: "u",
  date: daysBefore(NOW, age),
  foundAt: NOW.toISOString(),
});

describe("fit", () => {
  it("settles size, place and industry by code where the page states them", () => {
    const lines = buildFit(
      requirementsOf(profile),
      [{ id: "r1", verdict: "misses", reason: "No idea" }],
      facts({ place: "Leeds, LS1", size: "30 staff", industry: "Restaurant group" }),
      profile,
    );
    expect(lines.map((l) => l.verdict)).toEqual(["meets", "meets", "meets"]);
    const big = buildFit(requirementsOf(profile), [], facts({ size: "200 employees" }), profile);
    expect(big[2]).toMatchObject({ verdict: "misses", reason: "200 staff: more than your 50." });
  });

  it("takes the Checker's verdict otherwise; a misses without a reason is unknown", () => {
    const lines = buildFit(
      requirementsOf(profile),
      [
        { id: "r1", verdict: "misses" },
        { id: "r2", verdict: "partly", reason: "Serves Leeds from York." },
      ],
      facts({}),
      profile,
    );
    expect(lines.map((l) => l.verdict)).toEqual(["unknown", "partly", "unknown"]);
  });

  it("scores by weight", () => {
    expect(scoreFit([line("industry", "meets"), line("place", "meets")])).toBe(100);
    expect(scoreFit([line("industry", "misses"), line("place", "misses")])).toBe(0);
    expect(scoreFit([])).toBe(60);
  });

  it("finds your exclusions by code", () => {
    const p = { ...profile, excludeIndustries: ["gambling"], excludePlaces: ["Bradford"] };
    expect(excludedBy(facts({ industry: "Online gambling" }), p)).toMatch(/gambling/);
    expect(excludedBy(facts({ place: "Bradford, BD1" }), p)).toMatch(/Bradford/);
    expect(excludedBy(facts({ industry: "Restaurants" }), p)).toBeNull();
  });
});

describe("the lead score", () => {
  const good = [line("industry", "meets"), line("place", "meets")];
  const base = { fit: good, signals: [], evidence: 0, contacts: 1, excluded: null, now: NOW };

  it("lifts a good fit by its fresh signs", () => {
    expect(scoreLead({ ...base, kind: "asking", signals: [sign("asking", 0)] }).score).toBe(100);
    expect(scoreLead({ ...base, kind: "signs", signals: [sign("funding", 0)] }).score).toBe(78);
    expect(scoreLead({ ...base, kind: "signs" }).score).toBe(45);
    expect(isGoodLead(scoreLead({ ...base, kind: "signs" }).score)).toBe(false);
  });

  it("keeps a quiet fit under the hot leads", () => {
    expect(scoreLead({ ...base, kind: "quiet", evidence: 5 }).score).toBe(QUIET_CAP);
    expect(scoreLead({ ...base, kind: "quiet", evidence: 1 }).score).toBe(68);
  });

  it("caps for your exclusions, a wrong size, and no way to reach them", () => {
    const hot = { ...base, kind: "asking" as const, signals: [sign("asking", 0)] };
    expect(scoreLead({ ...hot, excluded: "It is in gambling." })).toEqual({
      score: 10,
      capped: "It is in gambling.",
    });
    expect(scoreLead({ ...hot, fit: [...good, line("size", "misses")] }).score).toBe(WRONG_SIZE_CAP);
    expect(scoreLead({ ...hot, contacts: 0 }).score).toBe(GOOD_LEAD - 1);
  });

  it("orders the board: asking now, then signs, then quiet fits", () => {
    const sorted = byBand([
      { kind: "quiet" as const, score: 70 },
      { kind: "signs" as const, score: 60 },
      { kind: "asking" as const, score: 55 },
      { kind: "signs" as const, score: 90 },
    ]);
    expect(sorted.map((l) => `${l.kind}${l.score}`)).toEqual(["asking55", "signs90", "signs60", "quiet70"]);
  });
});

describe("the quiet-fit bar", () => {
  const pass = {
    fit: [line("industry", "meets"), line("place", "meets")],
    evidence: 1,
    records: 1,
    ownSite: true,
  };
  it("needs a strong fit, a trait or clue, an official record and the company's own site", () => {
    expect(quietBar(pass)).toBeNull();
    expect(quietBar({ ...pass, records: 0 })).toBe("no official record confirms it");
    expect(quietBar({ ...pass, ownSite: false })).toBe("its own website wasn't found");
    expect(quietBar({ ...pass, evidence: 0 })).toMatch(/trait or clue/);
    expect(quietBar({ ...pass, fit: [line("industry", "unknown")] })).toBe("its industry isn't confirmed");
    expect(quietBar({ ...pass, fit: [line("must", "misses")] })).toMatch(/misses/);
  });
});
