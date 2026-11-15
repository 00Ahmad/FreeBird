import { describe, expect, it } from "vitest";

import { emptyProfile, mergeProfile } from "./profile";
import { careerSearches, CAREER_SITES } from "./searches";

describe("searches aimed at career sites", () => {
  it("search each career site for the first title, remote and the first place", () => {
    const profile = mergeProfile(emptyProfile(), {
      titles: ["Senior Backend Engineer", "API Developer"],
      workplace: ["remote"],
      places: ["UK", "Ireland"],
    });
    expect(careerSearches(profile)).toEqual(
      CAREER_SITES.map((site) => `"Senior Backend Engineer" remote UK site:${site}`),
    );
  });

  it("add the first must-have when it is a short keyword", () => {
    const profile = mergeProfile(emptyProfile(), {
      titles: ["Senior Backend Engineer"],
      workplace: ["remote"],
      places: ["UK"],
      mustHaves: ["Python"],
    });
    expect(careerSearches(profile, ["jobs.lever.co"])).toEqual([
      '"Senior Backend Engineer" Python remote UK site:jobs.lever.co',
    ]);
    const long = mergeProfile(profile, { mustHaves: ["at least five years of running teams"] });
    expect(careerSearches(long, ["jobs.lever.co"])).toEqual([
      '"Senior Backend Engineer" remote UK site:jobs.lever.co',
    ]);
  });

  it("leave out what the profile doesn't say, and quotes inside a title", () => {
    const profile = mergeProfile(emptyProfile(), { titles: ['Data "ML" Engineer'], workplace: ["office"] });
    expect(careerSearches(profile, ["jobs.lever.co"])).toEqual(['"Data ML Engineer" site:jobs.lever.co']);
    expect(careerSearches(emptyProfile())).toEqual([]);
  });
});
