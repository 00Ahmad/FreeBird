import { describe, expect, it } from "vitest";

import { isProviderList, mayRead, pickPages } from "./leads";
import { emptyOffer, mergeOffer } from "./profile";
import { isUkArea, placeOf, placesIn, servesAnywhere } from "./region";
import { allSignalSearches, signalSearches } from "./searches";

const NOW = new Date("2026-11-14T12:00:00Z");

describe("searches built from signs", () => {
  const profile = mergeOffer(emptyOffer(), {
    offer: "Payroll for restaurants",
    areas: ["UK", "Leeds"],
    industries: ["restaurants"],
  });

  it("look for the client's situation, never just the service's name", () => {
    const searches = signalSearches(profile, ["asking", "signs"], 0, NOW);
    expect(searches).toContainEqual({ query: '"looking for a payroll provider" Leeds', signal: "asking" });
    expect(searches).toContainEqual({
      query: '"Payroll Administrator" Leeds site:boards.greenhouse.io',
      signal: "hiring",
    });
    for (const s of searches) expect(s.query.toLowerCase()).not.toBe("payroll leeds");
  });

  it("only for the kinds of lead asked for, and something new each round", () => {
    expect(signalSearches(profile, ["asking"], 0, NOW).every((s) => s.signal === "asking")).toBe(true);
    expect(signalSearches(profile, ["quiet"], 0, NOW)).toEqual([]);
    const first = signalSearches(profile, ["signs"], 0, NOW).map((s) => s.query);
    const second = signalSearches(profile, ["signs"], 1, NOW).map((s) => s.query);
    expect(second.some((q) => first.includes(q))).toBe(false);
  });

  it("cover every place and industry, not only the first (2.3)", () => {
    const wide = mergeOffer(profile, { areas: ["Leeds", "York"], industries: ["restaurants", "hotels"] });
    const all = allSignalSearches(wide, ["asking", "signs"], NOW).map((s) => s.query);
    expect(all.some((q) => q.includes("York"))).toBe(true);
    expect(all.some((q) => q.includes("hotels"))).toBe(true);
    // The first searches of each sign come first, for each place in turn.
    expect(all[0]).toBe('"looking for a payroll provider" Leeds');
    expect(all.indexOf('"looking for a payroll provider" York')).toBeLessThan(
      all.indexOf('"recommend a payroll provider" Leeds'),
    );
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("which pages to read", () => {
  it("drops lists of providers: they list your competitors", () => {
    expect(isProviderList("https://news.test/best-payroll-companies-uk", ["payroll provider"])).toBe(true);
    expect(isProviderList("https://news.test/top-10-payroll-providers", ["payroll provider"])).toBe(true);
    expect(isProviderList("https://news.test/fastest-growing-companies-leeds", ["payroll provider"])).toBe(
      false,
    );
  });

  it("never reads sites that don't allow it, and puts job ads first", () => {
    expect(mayRead("https://www.linkedin.com/company/x")).toBe(false);
    expect(mayRead("https://www.upwork.com/jobs/x")).toBe(false);
    const picked = pickPages(
      [
        "https://news.test/a",
        "https://boards.greenhouse.io/brightside/jobs/1",
        "https://news.test/a?utm_source=x",
        "https://www.facebook.com/brightside",
        "https://news.test/best-payroll-companies",
        "https://news.test/read",
      ],
      new Set(["news.test/read"]),
      ["payroll provider"],
    );
    expect(picked).toEqual(["https://boards.greenhouse.io/brightside/jobs/1", "https://news.test/a"]);
  });
});

describe("regions", () => {
  it("know a UK area, the place to search near, and remote work", () => {
    expect(isUkArea(["Leeds"])).toBe(true);
    expect(isUkArea(["Toronto"])).toBe(false);
    expect(placeOf(["UK", "remote", "West Yorkshire"])).toBe("West Yorkshire");
    expect(placeOf(["UK"])).toBe("");
    expect(placeOf(["Leeds, UK"])).toBe("Leeds");
    expect(placesIn(["Leeds, West Yorkshire", "remote"])).toEqual(["Leeds", "West Yorkshire"]);
    expect(servesAnywhere(["Remote"])).toBe(true);
  });
});

describe("provider lists and redirects, found in the live run", () => {
  it("are known by their address pattern and by their own words", async () => {
    const { isProviderPage } = await import("./leads");
    expect(
      isProviderList("https://www.goodfirms.test/business-services/payroll-services/uk", [
        "payroll provider",
      ]),
    ).toBe(true);
    expect(isProviderList("https://news.test/leeds/payroll-hiring-news", ["payroll provider"])).toBe(false);
    expect(mayRead("https://startups.test/go/EH")).toBe(false);
    expect(mayRead("https://www.goodfirms.co/x")).toBe(false);
    expect(
      isProviderPage("The 7 best payroll service providers for small businesses in 2026", "", [
        "payroll provider",
      ]),
    ).toBe(true);
    expect(
      isProviderPage("Pages", "Goodfirms has reviewed 229 Payroll Companies in the UK", ["payroll provider"]),
    ).toBe(true);
    expect(
      isProviderPage("Brightside Kitchens is hiring", "A Payroll Administrator to join the team.", [
        "payroll provider",
      ]),
    ).toBe(false);
  });
});
