import { describe, expect, it } from "vitest";

import { amounts, checkFacts, checkNotes, factValue, onPage, supports } from "./source-check";

// A made-up posting: no real company, recruiter or text.
const PAGE = `Senior Backend Engineer
Northwind Robotics
Location: Leeds, United Kingdom (Hybrid - 2 days in the office)
Salary: £55,000 – £65,000 per year
Full-time, permanent
Posted 12 days ago
About us: Northwind Robotics builds warehouse robots and employs about 120 people.`;

describe("the source check", () => {
  it("keeps facts whose quote is on the page and says the value", () => {
    const checked = checkFacts(PAGE, [
      { name: "title", value: "Senior Backend Engineer", quote: "Senior Backend Engineer" },
      { name: "company", value: "Northwind Robotics", quote: "Northwind Robotics" },
      { name: "salary", value: "£55k–£65k a year", quote: "Salary: £55,000 – £65,000 per year" },
      { name: "workplace", value: "Hybrid", quote: "Hybrid - 2 days in the office" },
      { name: "posted", value: "12 days ago", quote: "Posted 12 days ago" },
    ]);
    expect(checked.confirmed).toBe(true);
    expect(factValue(checked.facts, "salary")).toBe("£55k–£65k a year");
    expect(factValue(checked.facts, "workplace")).toBe("Hybrid");
    expect(checked.dropped).toEqual([]);
  });

  it("refuses a real quote with an invented value attached", () => {
    const checked = checkFacts(PAGE, [
      { name: "title", value: "Senior Backend Engineer", quote: "Senior Backend Engineer" },
      { name: "company", value: "Northwind Robotics", quote: "Northwind Robotics" },
      { name: "salary", value: "£90,000", quote: "Salary: £55,000 – £65,000 per year" },
      { name: "workplace", value: "Remote", quote: "Hybrid - 2 days in the office" },
    ]);
    expect(factValue(checked.facts, "salary")).toBeNull();
    expect(factValue(checked.facts, "workplace")).toBeNull();
    expect(checked.dropped).toEqual([
      "workplace: the quote doesn't say it",
      "salary: the quote doesn't say it",
    ]);
  });

  it("refuses a quote that isn't on the page, and a title that isn't confirmed isn't a job", () => {
    const checked = checkFacts(PAGE, [
      { name: "title", value: "Staff Engineer", quote: "Staff Engineer, Platform" },
      { name: "company", value: "Northwind Robotics", quote: "Northwind Robotics" },
    ]);
    expect(checked.confirmed).toBe(false);
    expect(checked.dropped).toEqual(["title: the quote isn't on the page"]);
  });

  it("needs a quote, of a sensible length", () => {
    const checked = checkFacts(PAGE, [
      { name: "title", value: "Senior Backend Engineer" },
      { name: "company", value: "Northwind", quote: "Nort" },
    ]);
    expect(checked.dropped).toEqual(["title: no quote", "company: the quote isn't on the page"]);
    expect(onPage(PAGE, "x".repeat(401))).toBe(false);
  });

  it("reads quotes the way a person does: case, curly quotes, dashes and spaces don't matter", () => {
    expect(onPage(PAGE, "senior   BACKEND engineer")).toBe(true);
    expect(onPage(PAGE, "Salary: £55,000 - £65,000 per year")).toBe(true);
    expect(onPage("We’re hiring", "We're hiring")).toBe(true);
  });

  it("lists every fact, with unknown names and repeats ignored", () => {
    const checked = checkFacts(PAGE, [
      { name: "title", value: "Senior Backend Engineer", quote: "Senior Backend Engineer" },
      { name: "title", value: "Something else", quote: "nope nope" },
      { name: "favourite colour", value: "blue", quote: "Northwind" },
    ]);
    expect(checked.facts.map((fact) => fact.name)).toEqual([
      "title",
      "company",
      "location",
      "workplace",
      "salary",
      "seniority",
      "employment",
      "posted",
    ]);
    expect(factValue(checked.facts, "title")).toBe("Senior Backend Engineer");
  });

  it("matches the value's words to the quote's", () => {
    expect(supports("location", "Leeds, UK", "Location: Leeds, United Kingdom")).toBe(false);
    expect(supports("location", "Leeds", "Location: Leeds, United Kingdom")).toBe(true);
    expect(supports("employment", "Full-time", "Full-time, permanent")).toBe(true);
    expect(supports("title", "Senior Backend Engineers", "Senior Backend Engineer")).toBe(true);
  });

  it("reads amounts however they are written", () => {
    expect(amounts("£55k – £65k")).toEqual([55_000, 65_000]);
    expect(amounts("55.000 € bis 65.000 €")).toEqual([55_000, 65_000]);
    expect(amounts("$1.2m")).toEqual([1_200_000]);
    expect(amounts("55 000")).toEqual([55_000]);
  });

  it("keeps company notes only with a quote on the page that shares a word", () => {
    const notes = checkNotes(PAGE, [
      { text: "About 120 people", quote: "employs about 120 people" },
      { text: "Builds warehouse robots", quote: "builds warehouse robots" },
      { text: "Raised $50m last year", quote: "Northwind Robotics builds" },
      { text: "Huge", quote: "not on the page at all" },
    ]);
    expect(notes.map((note) => note.text)).toEqual(["About 120 people", "Builds warehouse robots"]);
  });
});
