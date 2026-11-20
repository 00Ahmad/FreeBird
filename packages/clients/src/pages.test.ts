import type { PageRead } from "@mrog/jobs";
import { describe, expect, it } from "vitest";

import { CLUES, cluesOn } from "./clues";
import { findContacts, mergeContacts } from "./contacts";
import { checkCompanyFacts, clientFact, hostIn, mergeFacts } from "./facts";
import { staffRange, staffText } from "./staff";
import { TRAITS, traitById } from "./traits";

const NOW = new Date("2026-11-14T12:00:00Z");
const page = (over: Partial<PageRead>): PageRead => ({
  url: "https://brightside-kitchens.test/",
  title: "Brightside Kitchens",
  text: "",
  links: [],
  reader: "text",
  humanCheck: false,
  ...over,
});

describe("staff numbers", () => {
  it("are read by code", () => {
    expect(staffRange("a team of 30 people")).toEqual({ min: 30, max: 30 });
    expect(staffRange("50-249 employees")).toEqual({ min: 50, max: 249 });
    expect(staffRange("over 100 staff")).toEqual({ min: 101, max: null });
    expect(staffRange("fewer than 10 staff")).toEqual({ min: 0, max: 9 });
    expect(staffRange("30+ staff")).toEqual({ min: 30, max: null });
    expect(staffRange("1,200 employees")).toEqual({ min: 1200, max: 1200 });
    expect(staffRange("I'm a sole trader")).toEqual({ min: 1, max: 1 });
    expect(staffRange("great food")).toBeNull();
    expect(staffText({ min: 50, max: 249 })).toBe("50–249");
  });
});

describe("the source check for companies", () => {
  const text =
    "Brightside Kitchens Ltd is a family restaurant group in Leeds. Our team of 30 serves three restaurants. Visit brightside-kitchens.test.";

  it("keeps a fact only when its quote is on the page and says it", () => {
    const checked = checkCompanyFacts(page({ text }), [
      {
        name: "company",
        value: "Brightside Kitchens Ltd",
        quote: "Brightside Kitchens Ltd is a family restaurant group",
      },
      { name: "place", value: "Leeds", quote: "a family restaurant group in Leeds" },
      { name: "size", value: "30 staff", quote: "Our team of 30" },
      { name: "industry", value: "Restaurants", quote: "made up line" },
      { name: "what", value: "Serves three restaurants", quote: "Our team of 30 serves three restaurants" },
    ]);
    expect(checked.confirmed).toBe(true);
    expect(clientFact(checked.facts, "place")).toBe("Leeds");
    expect(clientFact(checked.facts, "size")).toBe("30 staff");
    expect(clientFact(checked.facts, "industry")).toBeNull();
    expect(checked.dropped).toEqual(["industry: the quote isn't on the page"]);
  });

  it("refuses an invented size next to a real line", () => {
    const checked = checkCompanyFacts(page({ text }), [
      { name: "size", value: "300 staff", quote: "Our team of 30" },
    ]);
    expect(clientFact(checked.facts, "size")).toBeNull();
    expect(checked.confirmed).toBe(false);
  });

  it("takes a website as the page's own address, or one written on the page", () => {
    const own = checkCompanyFacts(page({ text }), [
      { name: "website", value: "https://www.brightside-kitchens.test" },
    ]);
    expect(clientFact(own.facts, "website")).toBe("brightside-kitchens.test");
    const made = checkCompanyFacts(page({ text }), [
      { name: "website", value: "brightside.example", quote: "x" },
    ]);
    expect(clientFact(made.facts, "website")).toBeNull();
    expect(hostIn("not a site")).toBeNull();
  });

  it("merges two pages' facts, the first page first", () => {
    const a = checkCompanyFacts(page({ text }), [{ name: "place", value: "Leeds", quote: "in Leeds" }]).facts;
    const b = checkCompanyFacts(page({ text }), [{ name: "size", value: "30", quote: "team of 30" }]).facts;
    const merged = mergeFacts(a, b);
    expect([clientFact(merged, "place"), clientFact(merged, "size")]).toEqual(["Leeds", "30"]);
  });
});

describe("contact routes", () => {
  it("are company-level only, found by code", () => {
    const found = findContacts(
      page({
        text: "Say hello@brightside-kitchens.test or jane.smith@brightside-kitchens.test or owner@gmail.com. Tel: 0113 496 0000. Mobile 07700 900123",
        links: [{ text: "Contact us", url: "https://brightside-kitchens.test/contact" }],
      }),
    );
    expect(found).toEqual([
      {
        kind: "contact_page",
        value: "https://brightside-kitchens.test/contact",
        url: "https://brightside-kitchens.test/",
      },
      { kind: "email", value: "hello@brightside-kitchens.test", url: "https://brightside-kitchens.test/" },
      { kind: "phone", value: "0113 496 0000", url: "https://brightside-kitchens.test/" },
    ]);
  });

  it("never keep a mobile number or a link to another site's contact page", () => {
    const found = findContacts(
      page({
        text: "Call 07700 900123",
        links: [{ text: "Contact", url: "https://other.test/contact" }],
      }),
    );
    expect(found).toEqual([]);
  });

  it("never take another company's inbox from the page (1.6)", () => {
    const found = findContacts(
      page({
        url: "https://junipercafe.test/",
        text: "Juniper Cafe. Email info@junipercafe.test or bookings@mail.junipercafe.test. Site by Pixel Agency hello@pixelagency.test",
      }),
    );
    expect(found.filter((c) => c.kind === "email").map((c) => c.value)).toEqual([
      "info@junipercafe.test",
      "bookings@mail.junipercafe.test",
    ]);
    // A site on a shared host: its own domain, when known, is the one that counts.
    const shared = findContacts(
      page({ url: "https://juniper.wixsite.com/cafe", text: "Email hello@junipercafe.test" }),
      "junipercafe.test",
    );
    expect(shared.map((c) => c.value)).toEqual(["hello@junipercafe.test"]);
  });

  it("merge without repeats", () => {
    const a = { kind: "email" as const, value: "hello@a.test", url: "u" };
    expect(mergeContacts([a], [{ ...a, value: "HELLO@a.test" }])).toHaveLength(1);
  });
});

describe("a sign quoted too thinly (found in the benchmark)", () => {
  it("is taken from the page's own sentence that says it", async () => {
    const { checkSigns } = await import("./assemble");
    const { emptyOffer, mergeOffer, playbookOf } = await import("./index");
    const profile = mergeOffer(emptyOffer(), { offer: "Payroll for restaurants" });
    const news = page({
      url: "https://news.test/brightside",
      text: "Brightside Kitchens is hiring\nPublished 3 November 2026\nLeeds restaurant group Brightside Kitchens is advertising for a Payroll Administrator to join its team.",
    });
    const signs = checkSigns(
      news,
      [{ kind: "hiring", quote: "Brightside Kitchens is hiring", date: "3 November 2026" }],
      profile,
      playbookOf(profile),
      NOW,
    );
    expect(signs).toMatchObject([
      {
        kind: "hiring",
        quote:
          "Leeds restaurant group Brightside Kitchens is advertising for a Payroll Administrator to join its team.",
        date: "2026-11-03",
      },
    ]);
    // A quote that isn't on the page still gives nothing.
    expect(
      checkSigns(
        news,
        [{ kind: "hiring", quote: "We need a payroll clerk" }],
        profile,
        playbookOf(profile),
        NOW,
      ),
    ).toEqual([]);
  });

  it("is found by code in a company's own quote when the kind given isn't a sign (found in the benchmark)", async () => {
    const { signsInQuote } = await import("./assemble");
    const { emptyOffer, mergeOffer, playbookOf } = await import("./index");
    const profile = mergeOffer(emptyOffer(), { offer: "Payroll for restaurants" });
    const quote =
      "Leeds restaurant group Brightside Kitchens is advertising for a Payroll Administrator to join its team.";
    expect(signsInQuote(quote, profile, playbookOf(profile), NOW)).toEqual(["hiring"]);
    expect(signsInQuote("Brightside Kitchens serves great food.", profile, playbookOf(profile), NOW)).toEqual(
      [],
    );
  });

  it("never borrows another company's sentence further down the page", async () => {
    const { checkSigns } = await import("./assemble");
    const { emptyOffer, mergeOffer, playbookOf } = await import("./index");
    const profile = mergeOffer(emptyOffer(), { offer: "Payroll for restaurants" });
    const roundUp = page({
      url: "https://news.test/roundup",
      text: [
        "Pine Cafe is hiring.",
        "Pine Cafe opened in Leeds in 2019.",
        "It serves breakfast all day.",
        "It has a garden.",
        "Elsewhere, Brightside Kitchens is advertising for a Payroll Administrator.",
      ].join("\n"),
    });
    expect(
      checkSigns(
        roundUp,
        [{ kind: "hiring", quote: "Pine Cafe is hiring" }],
        profile,
        playbookOf(profile),
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("traits found by code (2.6)", () => {
  it("quote the first sentence that says each trait you look for", async () => {
    const { findTraits } = await import("./assemble");
    const { emptyOffer, mergeOffer } = await import("./profile");
    const profile = mergeOffer(emptyOffer(), {
      offer: "Payroll",
      traits: ["has_staff", "multi_site", "regulated"],
    });
    const found = findTraits(
      page({ text: "Welcome! Our team of 30 serves three restaurants across Leeds.\nWe love food." }),
      profile,
    );
    expect(found.map((e) => [e.id, e.quote])).toEqual([
      ["has_staff", "Our team of 30 serves three restaurants across Leeds."],
      ["multi_site", "Our team of 30 serves three restaurants across Leeds."],
    ]);
  });
});

describe("traits", () => {
  it("each has its own id and checks its quote by code", () => {
    expect(new Set(TRAITS.map((t) => t.id)).size).toBe(TRAITS.length);
    expect(traitById("has_staff")!.indicates("our team of 30")).toBe(true);
    expect(traitById("has_staff")!.indicates("a team of 3")).toBe(false);
    expect(traitById("multi_site")!.indicates("We run 3 restaurants")).toBe(true);
    expect(traitById("multi_site")!.indicates("our 1 shop")).toBe(false);
    expect(traitById("regulated")!.indicates("Rated Good by the Care Quality Commission")).toBe(true);
    expect(traitById("seasonal")!.indicates("We take on seasonal staff each summer")).toBe(true);
    expect(traitById("international")!.indicates("We operate in 4 countries")).toBe(true);
  });
});

describe("website clues", () => {
  const links = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      text: `Page ${i}`,
      url: `https://brightside-kitchens.test/p${i}`,
    }));

  it("are checked by code alone", () => {
    expect(new Set(CLUES.map((c) => c.id)).size).toBe(CLUES.length);
    const old = page({
      url: "http://brightside-kitchens.test/",
      text: "© 2018 Brightside. Email us: brightside@gmail.com",
      links: links(8),
    });
    const found = cluesOn(old, ["old_copyright", "no_https", "free_email", "no_blog", "no_booking"], NOW).map(
      (c) => c.id,
    );
    expect(found).toEqual(["old_copyright", "no_https", "free_email", "no_blog", "no_booking"]);
    // The address itself is never kept: only its provider.
    expect(cluesOn(old, ["free_email"], NOW)[0]!.text).not.toContain("brightside@");
  });

  it("say nothing about what a page lacks unless it is a loaded home page", () => {
    expect(cluesOn(page({ links: links(2) }), ["no_blog"], NOW)).toEqual([]);
    expect(
      cluesOn(page({ url: "https://brightside-kitchens.test/menu", links: links(9) }), ["no_blog"], NOW),
    ).toEqual([]);
    const fine = page({
      text: "© 2026. Book a table",
      links: [...links(8), { text: "Blog", url: "https://brightside-kitchens.test/blog" }],
    });
    expect(cluesOn(fine, ["old_copyright", "no_blog", "no_booking"], NOW)).toEqual([]);
    expect(cluesOn(page({ text: "Call us to order your cake" }), ["orders_by_phone"], NOW)).toHaveLength(1);
  });
});

describe("facts as a small model writes them (found in the live run)", () => {
  const text =
    "Mumtaz Leeds. Authentic Kashmiri cuisine in Leeds LS10 1PJ. Cinnamon Kitchen Leeds at City Square.";

  it("takes a short quote as the value when the value is missing", async () => {
    const { tidyClaims } = await import("./facts");
    const checked = checkCompanyFacts(page({ text }), [
      { name: "company", quote: "Mumtaz Leeds" },
      { name: "place", quote: "Leeds LS10 1PJ" },
    ]);
    expect([clientFact(checked.facts, "company"), clientFact(checked.facts, "place")]).toEqual([
      "Mumtaz Leeds",
      "Leeds LS10 1PJ",
    ]);
    expect(tidyClaims(text, [{ name: "company", quote: "x".repeat(200) }])[0]!.value).toBe("");
  });

  it("reads a company's name used as the fact's label, only when the name is on the page", () => {
    const own = { text, title: "Cinnamon Kitchen Leeds | City Square", url: "https://cinnamonkitchen.test/" };
    const named = checkCompanyFacts(page(own), [
      { name: "Cinnamon Kitchen Leeds", quote: "a long line", value: "" },
    ]);
    expect(clientFact(named.facts, "company")).toBe("Cinnamon Kitchen Leeds");
    const made = checkCompanyFacts(page(own), [{ name: "Invented Bistro", quote: "x" }]);
    expect(made.confirmed).toBe(false);
  });

  it("never makes a field's name the company (1.3)", () => {
    const cafe = page({
      url: "https://junipercafe.test/",
      title: "Juniper Cafe",
      text: "Juniper Cafe. Our services include catering. Email us, call us, or find our address and location below. Contact the team.",
    });
    for (const label of ["services", "email", "phone", "address", "contact", "location"]) {
      const checked = checkCompanyFacts(cafe, [{ name: label, quote: "Our services include catering" }]);
      expect(clientFact(checked.facts, "company")).not.toBe(label);
    }
    // A name that isn't the page's own (not its title, not its address) isn't taken either.
    const other = checkCompanyFacts(
      page({ ...cafe, text: `${cafe.text} Cinnamon Kitchen Leeds caters too.` }),
      [{ name: "Cinnamon Kitchen Leeds", quote: "caters too" }],
    );
    expect(other.confirmed).toBe(false);
  });
});
