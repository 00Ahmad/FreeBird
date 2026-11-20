import { describe, expect, it } from "vitest";

import {
  emptyProfile,
  MAX_REQUIREMENTS,
  mergeProfile,
  missingForApproval,
  profileText,
  requirementsLeftOut,
  requirementsOf,
} from "./profile";

describe("the profile", () => {
  it("starts empty and says what it still needs", () => {
    expect(missingForApproval(emptyProfile())).toEqual([
      "the job titles you want",
      "where you'd work (remote, hybrid or office, and which places)",
    ]);
    const ready = mergeProfile(emptyProfile(), { titles: ["Backend Engineer"], workplace: ["remote"] });
    expect(missingForApproval(ready)).toEqual([]);
  });

  it("replaces a field with the list sent, without repeats", () => {
    const one = mergeProfile(emptyProfile(), {
      titles: ["Backend Engineer", "backend engineer ", "API Developer"],
    });
    expect(one.titles).toEqual(["Backend Engineer", "API Developer"]);
    const two = mergeProfile(one, { titles: ["API Developer"], places: ["Leeds"] });
    expect(two.titles).toEqual(["API Developer"]);
    expect(two.places).toEqual(["Leeds"]);
  });

  it("refuses a change that breaks a limit", () => {
    expect(() =>
      mergeProfile(emptyProfile(), { titles: Array.from({ length: 11 }, (_, i) => `T${i}`) }),
    ).toThrow();
  });

  it("reads as plain lines, leaving empty fields out", () => {
    const profile = mergeProfile(emptyProfile(), {
      titles: ["Backend Engineer"],
      minSalary: { amount: 55000, currency: "GBP", period: "year" },
    });
    expect(profileText(profile)).toBe("- Job titles: Backend Engineer\n- Lowest salary: 55,000 GBP a year");
  });

  it("becomes numbered requirements of each kind", () => {
    const profile = mergeProfile(emptyProfile(), {
      titles: ["Backend Engineer"],
      relatedTitles: ["Platform Engineer"],
      workplace: ["remote", "hybrid"],
      places: ["Leeds"],
      minSalary: { amount: 55000, currency: "GBP", period: "year" },
      mustHaves: ["Python"],
      dealBreakers: ["on-call every week"],
      avoidIndustries: ["gambling"],
      niceToHaves: ["4-day week"],
    });
    expect(requirementsOf(profile)).toEqual([
      {
        id: "r1",
        kind: "title",
        text: "Same kind of job as: Backend Engineer (or related: Platform Engineer) (another title for the same work counts)",
        titles: ["Backend Engineer", "Platform Engineer"],
      },
      { id: "r2", kind: "workplace", text: "Workplace: remote or hybrid", workplaces: ["remote", "hybrid"] },
      { id: "r3", kind: "place", text: "In or open to: Leeds" },
      {
        id: "r4",
        kind: "salary",
        text: "Pays at least 55,000 GBP a year",
        floor: { amount: 55000, currency: "GBP", period: "year" },
      },
      // Deal-breakers come before must-haves, so a long list never cuts them off.
      { id: "r5", kind: "dealbreaker", text: "Free of: on-call every week" },
      { id: "r6", kind: "dealbreaker", text: "Not in the gambling industry" },
      { id: "r7", kind: "must", text: "Python" },
      { id: "r8", kind: "nice", text: "4-day week" },
    ]);
  });

  it("keeps the list short enough for a small model", () => {
    const profile = mergeProfile(emptyProfile(), {
      titles: ["X"],
      mustHaves: Array.from({ length: 20 }, (_, i) => `must ${i}`),
      niceToHaves: Array.from({ length: 20 }, (_, i) => `nice ${i}`),
    });
    expect(requirementsOf(profile)).toHaveLength(MAX_REQUIREMENTS);
  });

  it("never cuts a deal-breaker or a company to avoid, and says how many it left out", () => {
    const profile = mergeProfile(emptyProfile(), {
      titles: ["Backend Engineer"],
      seniority: "Senior",
      workplace: ["remote"],
      places: ["UK"],
      rightToWork: "UK citizen",
      mustHaves: Array.from({ length: 20 }, (_, i) => `must ${i}`),
      niceToHaves: Array.from({ length: 5 }, (_, i) => `nice ${i}`),
      dealBreakers: Array.from({ length: 6 }, (_, i) => `breaker ${i}`),
      avoidIndustries: ["gambling"],
      avoidCompanies: ["Acme", "Globex"],
    });
    const list = requirementsOf(profile);
    // Before: 20 must-haves came first, and only 4 deal-breakers and no company to avoid were checked.
    expect(list.filter((r) => r.kind === "dealbreaker" && !r.company)).toHaveLength(7);
    expect(list.filter((r) => r.company).map((r) => r.company)).toEqual(["Acme", "Globex"]);
    expect(list.filter((r) => !r.company)).toHaveLength(MAX_REQUIREMENTS);
    // Title, workplace, place, 7 to avoid, seniority, right to work, 20 must-haves, 5 nice-to-haves: 37.
    expect(requirementsLeftOut(profile)).toBe(37 - MAX_REQUIREMENTS);
  });
});
