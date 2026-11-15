import { describe, expect, it } from "vitest";

import { companyDomain, companyPrints, nameKey, siteFitsName } from "./identity";
import { addToList, emptyLists, listedIn, parseEntries, removeFromList } from "./lists";

describe("telling companies apart", () => {
  it("by their own domain, never a host many share", () => {
    expect(companyDomain("https://www.brightside-kitchens.test/menu")).toBe("brightside-kitchens.test");
    expect(companyDomain("https://boards.greenhouse.io/brightside")).toBeNull();
    expect(companyDomain("https://www.linkedin.com/company/x")).toBeNull();
    expect(nameKey("The Brightside Kitchens Ltd")).toBe("brightside kitchens");
    expect(companyPrints({ domain: "b.test", name: "Brightside Group Limited" })).toEqual([
      "d:b.test",
      "n:brightside",
    ]);
  });

  it("pick a company's own site from search results by its name", () => {
    expect(siteFitsName("https://brightsidekitchens.co.uk/", "Brightside Kitchens Ltd")).toBe(true);
    expect(siteFitsName("https://www.brightside-kitchens.test/", "Brightside Kitchens Ltd")).toBe(true);
    expect(siteFitsName("https://brightside.co.uk/", "Brightside Kitchens Ltd")).toBe(true);
    expect(siteFitsName("https://www.yell.com/brightside", "Brightside Kitchens Ltd")).toBe(false);
    expect(siteFitsName("https://kitchenfitters.test/", "Brightside Kitchens Ltd")).toBe(false);
  });
});

describe("your lists", () => {
  it("read pasted lines and CSV, skipping a header", () => {
    const entries = parseEntries(
      'Company,Website\nBrightside Kitchens,brightside-kitchens.test\n"Oak & Ash, Leeds",\nhello@pinecafe.test\n\n,,',
    );
    expect(entries).toEqual([
      { name: "Brightside Kitchens", domain: "brightside-kitchens.test" },
      { name: "Oak & Ash, Leeds", domain: null },
      { name: "pinecafe.test", domain: "pinecafe.test" },
    ]);
  });

  it("are checked by name or domain, without repeats", () => {
    let lists = addToList(emptyLists(), "clients", parseEntries("Brightside Kitchens Ltd"));
    lists = addToList(lists, "doNotContact", [{ name: "Pine Cafe", domain: "pinecafe.test" }]);
    lists = addToList(lists, "clients", parseEntries("brightside kitchens"));
    expect(lists.clients).toHaveLength(1);
    expect(listedIn({ name: "The Brightside Kitchens", domain: null }, lists)).toBe("clients");
    expect(listedIn({ name: "Something else", domain: "pinecafe.test" }, lists)).toBe("doNotContact");
    expect(listedIn({ name: "New Co", domain: "new.test" }, lists)).toBeNull();
    expect(removeFromList(lists, "clients", lists.clients[0]!).clients).toEqual([]);
  });
});

describe("a company's name from its own site (found in the live run)", () => {
  it("is the phrase on the page that spells the site's address", async () => {
    const { nameOnSite } = await import("./identity");
    expect(
      nameOnSite({ url: "https://madfrans.test/", text: "MENUS | WELCOME TO MAD FRANS | Bar & kitchen" }),
    ).toBe("MAD FRANS");
    expect(
      nameOnSite({
        url: "https://www.thecutandcraft.co.uk/leeds/",
        text: "Private dining at The Cut & Craft Leeds",
      }),
    ).toBe("The Cut & Craft");
    expect(nameOnSite({ url: "https://mumtazleeds.co.uk/", text: "Welcome to Mumtaz Leeds." })).toBe(
      "Mumtaz Leeds",
    );
    expect(nameOnSite({ url: "https://madfrans.test/", text: "A bar in the city." })).toBeNull();
    expect(nameOnSite({ url: "https://www.yell.com/x", text: "Yell" })).toBeNull();
  });
});
