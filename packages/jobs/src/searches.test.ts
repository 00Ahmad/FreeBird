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

describe("code-made searches across rounds and scans", async () => {
  const { codeSearches, recentSearches, SEARCH_REPEAT_DAYS } = await import("./searches");
  const { rankHits } = await import("./leads");
  it("go through every title and place, not the first one again", () => {
    const profile = mergeProfile(emptyProfile(), {
      titles: ["Backend Engineer"],
      relatedTitles: ["Platform Engineer"],
      workplace: ["remote"],
      places: ["Leeds"],
    });
    const all = codeSearches(profile, ["jobs.lever.co"]);
    expect(all).toEqual([
      '"Backend Engineer" remote site:jobs.lever.co',
      '"Backend Engineer" Leeds site:jobs.lever.co',
      '"Platform Engineer" remote site:jobs.lever.co',
      '"Platform Engineer" Leeds site:jobs.lever.co',
    ]);
  });

  it("remember searches run lately, and forget them after two weeks", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const old = new Date(now.getTime() - (SEARCH_REPEAT_DAYS + 1) * 86_400_000).toISOString();
    expect(
      recentSearches(
        [
          { query: "A", at: "2026-11-19T00:00:00Z" },
          { query: "B", at: old },
        ],
        now,
      ),
    ).toEqual(["a"]);
  });

  it("rank results by the title the search showed, and drop a posting of another job", () => {
    const hits = [
      { url: "https://acme.example/jobs/123-product-designer", title: "Product Designer - Acme" },
      { url: "https://acme.example/careers", title: "Careers at Acme" },
      { url: "https://beta.example/jobs/456", title: "Senior Backend Engineer | Beta" },
      "https://gamma.example/jobs/789",
    ];
    expect(rankHits(hits, ["Backend Engineer"])).toEqual([
      "https://beta.example/jobs/456",
      "https://acme.example/careers",
      "https://gamma.example/jobs/789",
    ]);
  });
});
