import { describe, expect, it } from "vitest";

import {
  emptyProfile,
  MAX_REQUIREMENTS,
  mergeProfile,
  missingForApproval,
  profileText,
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
      { id: "r2", kind: "workplace", text: "Workplace: remote or hybrid" },
      { id: "r3", kind: "place", text: "In or open to: Leeds" },
      { id: "r4", kind: "salary", text: "Pays at least 55,000 GBP a year" },
      { id: "r5", kind: "must", text: "Python" },
      { id: "r6", kind: "dealbreaker", text: "Free of: on-call every week" },
      { id: "r7", kind: "dealbreaker", text: "Not in the gambling industry" },
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
});
