import { describe, expect, it } from "vitest";

import { siteFitsName } from "./identity";
import { sameCompany, sameRecord, tellingWords } from "./names";

describe("telling two companies apart by name (1.4)", () => {
  it("keeps only the words that tell a company apart", () => {
    expect(tellingWords("Brightside Kitchens Ltd")).toEqual(["brightside"]);
    // A place and a trade word say nothing on their own.
    expect(tellingWords("Leeds Kitchen Co Ltd")).toEqual([]);
  });

  it("needs every word of the shorter name in the longer one, and one of them telling", () => {
    expect(sameCompany("Brightside Kitchens", "BRIGHTSIDE KITCHENS LTD")).toBe(true);
    expect(sameCompany("Brightside", "Brightside Kitchens Ltd")).toBe(true);
    expect(sameCompany("Mad Frans", "MAD FRANS LIMITED")).toBe(true);
    expect(sameCompany("The Cut & Craft", "Cut and Craft Barbers Ltd")).toBe(true);
    expect(sameCompany("Leeds Kitchen Co", "Leeds Kitchen Co Ltd")).toBe(true);
    // Sharing one word was enough before.
    expect(sameCompany("Brightside Kitchens Ltd", "Brightside Cleaning Ltd")).toBe(false);
    expect(sameCompany("Leeds Kitchen Co Ltd", "Leeds Live")).toBe(false);
    expect(sameCompany("Leeds Kitchen Co", "Kitchen")).toBe(false);
    expect(sameCompany("", "Brightside")).toBe(false);
  });

  it("checks a register record's place when both are known", () => {
    expect(
      sameRecord(
        { name: "BRIGHTSIDE KITCHENS LTD", place: "Leeds, LS1 4AB" },
        "Brightside Kitchens",
        "Leeds",
      ),
    ).toBe(true);
    expect(
      sameRecord({ name: "BRIGHTSIDE KITCHENS LTD", place: "Bradford, BD1" }, "Brightside Kitchens", "Leeds"),
    ).toBe(false);
    // A place not known on one side doesn't count against it.
    expect(sameRecord({ name: "BRIGHTSIDE KITCHENS LTD", place: null }, "Brightside Kitchens", "Leeds")).toBe(
      true,
    );
    expect(
      sameRecord({ name: "BRIGHTSIDE CLEANING LTD", place: "Leeds" }, "Brightside Kitchens", "Leeds"),
    ).toBe(false);
  });
});

describe("a company's own site by its address (1.4)", () => {
  it("no longer takes a news site or another company's site", () => {
    expect(siteFitsName("https://www.leeds-live.co.uk/news", "Leeds Kitchen Co Ltd")).toBe(false);
    expect(siteFitsName("https://brightsidecleaning.co.uk", "Brightside Kitchens Ltd")).toBe(false);
    expect(siteFitsName("https://leeds.co.uk", "Leeds Kitchen Co")).toBe(false);
    expect(siteFitsName("https://cafe.co.uk", "Pine Cafe")).toBe(false);
  });

  it("still takes the company's own", () => {
    expect(siteFitsName("https://www.brightsidekitchens.co.uk/about", "Brightside Kitchens Ltd")).toBe(true);
    expect(siteFitsName("https://brightside.co.uk", "Brightside Kitchens Ltd")).toBe(true);
    expect(siteFitsName("https://thebrightside.co.uk", "Brightside Kitchens Ltd")).toBe(true);
    expect(siteFitsName("https://leedskitchen.co.uk", "Leeds Kitchen Co")).toBe(true);
    expect(siteFitsName("https://pinecafe.test", "Pine Cafe")).toBe(true);
    expect(siteFitsName("https://madfrans.com", "Mad Frans")).toBe(true);
  });
});
