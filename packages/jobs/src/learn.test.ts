import { describe, expect, it } from "vitest";

import { suggestFrom } from "./learn";
import { emptyProfile, mergeProfile } from "./profile";

const profile = emptyProfile();

describe("learning from your reactions", () => {
  it("a 👎 naming the company suggests avoiding it", () => {
    expect(suggestFrom("down", "Not at Acme again", { company: "Acme" }, profile)).toEqual({
      field: "avoidCompanies",
      value: "Acme",
      because: "You said: Not at Acme again",
    });
  });

  it("a 👎 about an industry suggests avoiding it", () => {
    expect(suggestFrom("down", "no fintech industry", { company: null }, profile)?.field).toBe(
      "avoidIndustries",
    );
  });

  it("a 👎 about seniority or pay suggests that field, not a deal-breaker", () => {
    // Before: "too junior" became the deal-breaker "too junior", which no Checker can judge.
    expect(suggestFrom("down", "too junior", { company: "Acme" }, profile)).toMatchObject({
      field: "seniority",
      value: "Senior",
    });
    expect(
      suggestFrom("down", "salary too low", { company: null, salary: "£40,000 - £45,000 a year" }, profile),
    ).toMatchObject({
      field: "minSalary",
      value: "45001 GBP year",
    });
    // A job that doesn't say what it pays gives nothing to go by.
    expect(suggestFrom("down", "pay too low", { company: null, salary: null }, profile)).toBeNull();
  });

  it("any other 👎 reason suggests a deal-breaker", () => {
    expect(suggestFrom("down", "too much travel", { company: "Acme" }, profile)).toMatchObject({
      field: "dealBreakers",
      value: "too much travel",
    });
    expect(suggestFrom("down", "no weekly on-call", { company: null }, profile)?.value).toBe(
      "weekly on-call",
    );
  });

  it("a 👍 reason suggests a nice-to-have", () => {
    expect(suggestFrom("up", "4-day week", { company: null }, profile)).toMatchObject({
      field: "niceToHaves",
    });
  });

  it("suggests nothing without a reason, or what the profile already has", () => {
    expect(suggestFrom("down", " ", { company: null }, profile)).toBeNull();
    const has = mergeProfile(profile, { dealBreakers: ["Too much travel"] });
    expect(suggestFrom("down", "too much travel", { company: null }, has)).toBeNull();
    const senior = mergeProfile(profile, { seniority: "senior" });
    expect(suggestFrom("down", "too junior", { company: null }, senior)).toBeNull();
  });
});
