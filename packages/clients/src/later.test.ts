import type { Lead } from "@mrog/shared";
import { describe, expect, it } from "vitest";

import { sizePattern, suggestFrom } from "./learn";
import { lookalikeProfile, lookalikeText } from "./lookalike";
import { emptyOffer, mergeOffer } from "./profile";
import { movedUpText, newSignals, pickWatched } from "./watch";

const NOW = new Date("2026-11-14T12:00:00Z");
const lead = (over: Partial<Lead>): Lead => ({
  id: "l",
  kind: "quiet",
  company: "Brightside Kitchens",
  domain: "brightside-kitchens.test",
  url: "https://brightside-kitchens.test/",
  site: "brightside-kitchens.test",
  readBy: "text",
  foundAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  scan: 1,
  column: "new",
  facts: [],
  signals: [],
  evidence: [],
  records: [],
  contacts: [],
  fit: [],
  score: 60,
  ownSite: true,
  summary: "",
  warnings: [],
  watch: true,
  checkedAt: NOW.toISOString(),
  movedUp: null,
  reaction: null,
  reason: null,
  note: "",
  ...over,
});
const sized = (n: number, over: Partial<Lead> = {}) =>
  lead({ facts: [{ name: "size", value: `${n} staff`, quote: `${n} staff` }], ...over });

describe("lookalikes", () => {
  const seed = (sic: string[], incorporated: string, area = "Leeds") => ({
    sicCodes: sic,
    employees: null,
    area,
    incorporated,
  });

  it("work out what your clients share", () => {
    const profile = lookalikeProfile(
      [
        seed(["56101"], "2020-01-01"),
        seed(["56101", "56302"], "2016-05-01"),
        seed(["56102"], "2022-03-01", "York"),
      ],
      NOW,
    );
    expect(profile).toEqual({
      sicCodes: ["56101"],
      sizeMin: null,
      sizeMax: null,
      area: "Leeds",
      ageMin: 2,
      ageMax: 12,
      from: 3,
    });
    expect(lookalikeText(profile as never)).toBe("industry codes 56101, Leeds, 2–12 years old");
  });

  it("fall back to the broad industry, and say so when there's nothing in common", () => {
    const broad = lookalikeProfile(
      [seed(["56101"], "2020-01-01"), seed(["56102"], "2020-01-01"), seed(["56103"], "2020-01-01")],
      NOW,
    );
    expect("sicCodes" in broad && broad.sicCodes).toEqual(["56101", "56102", "56103"]);
    expect(lookalikeProfile([seed(["1"], "2020-01-01")], NOW)).toMatchObject({ error: /at least 3/ });
    expect(
      lookalikeProfile(
        [seed(["56101"], "2020-01-01"), seed(["62012"], "2020-01-01"), seed(["86230"], "2020-01-01")],
        NOW,
      ),
    ).toMatchObject({
      error: /don't share/,
    });
  });
});

describe("the watch list", () => {
  it("re-checks the longest unchecked quiet fits first, at most the limit", () => {
    const leads = [
      lead({ id: "a", checkedAt: "2026-11-10T00:00:00.000Z" }),
      lead({ id: "b", checkedAt: "2026-11-01T00:00:00.000Z" }),
      lead({ id: "c", kind: "signs" }),
      lead({ id: "d", watch: false }),
      lead({ id: "e", column: "not_a_fit" }),
    ];
    expect(pickWatched(leads, 1).map((l) => l.id)).toEqual(["b"]);
    expect(pickWatched(leads).map((l) => l.id)).toEqual(["b", "a"]);
  });

  it("finds only new signs, and says what changed", () => {
    const known = {
      kind: "hiring" as const,
      quote: "Payroll Officer",
      url: "u",
      date: "2026-11-03",
      foundAt: NOW.toISOString(),
    };
    const fresh = newSignals(lead({ signals: [known] }), [
      known,
      { ...known, kind: "expanding", quote: "opening a new site" },
    ]);
    expect(fresh.map((s) => s.kind)).toEqual(["expanding"]);
    expect(movedUpText([known])).toBe("Hiring for your work (2026-11-03)");
  });
});

describe("learning", () => {
  const profile = mergeOffer(emptyOffer(), { offer: "Payroll" });

  it("suggests from a reason, never applies", () => {
    expect(suggestFrom("down", "too big for us", sized(300), profile, [])).toMatchObject({
      field: "sizeMax",
      value: "299",
    });
    expect(suggestFrom("down", "too small", sized(3), profile, [])).toMatchObject({
      field: "sizeMin",
      value: "4",
    });
    const pub = lead({ facts: [{ name: "industry", value: "Pubs", quote: "Pubs" }] });
    expect(suggestFrom("down", "we don't work with this industry", pub, profile, [])).toMatchObject({
      field: "excludeIndustries",
      value: "Pubs",
    });
    expect(suggestFrom("up", "too big", sized(300), profile, [])).toBeNull();
  });

  it("sees a pattern of turned-down sizes", () => {
    const board = [
      sized(250, { reaction: "down" }),
      sized(400, { reaction: "down" }),
      sized(300, { reaction: "down" }),
    ];
    expect(sizePattern(board, profile)).toMatchObject({ field: "sizeMax", value: "249" });
    expect(sizePattern([...board, sized(500, { reaction: "up" })], profile)).toBeNull();
    expect(sizePattern(board.slice(0, 2), profile)).toBeNull();
  });
});
