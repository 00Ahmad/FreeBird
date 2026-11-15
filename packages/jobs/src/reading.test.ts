import { describe, expect, it } from "vitest";

import { canonicalUrl, employerSite, fingerprints, isSeen, remember, siteOf } from "./dedupe";
import { judge, MIN_PAGE_CHARS, readersFor } from "./ladder";
import { leadKind, looksLikeJob, mayFollowLinks, pickLeads } from "./leads";
import { linksFromText, linksOnPage } from "./links";
import type { PageRead } from "./page";

const page = (over: Partial<PageRead> = {}): PageRead => ({
  url: "https://jobs.example.com/1",
  title: "Job",
  text: "A real job posting. ".repeat(40),
  links: [],
  reader: "text",
  humanCheck: false,
  ...over,
});

describe("telling jobs apart", () => {
  it("tidies addresses", () => {
    expect(canonicalUrl("https://www.Example.com/jobs/1/?utm_source=x&b=2&a=1#apply")).toBe(
      "example.com/jobs/1?a=1&b=2",
    );
    expect(canonicalUrl("ftp://example.com")).toBeNull();
    expect(canonicalUrl("not a url")).toBeNull();
    expect(siteOf("https://www.Example.com/x")).toBe("example.com");
  });

  it("knows the same job by address, or by company, title and place", () => {
    const one = fingerprints({
      url: "https://a.com/jobs/1?utm_medium=x",
      company: "Acme Ltd",
      title: "Backend Engineer",
      location: "Leeds",
    });
    const two = fingerprints({
      url: "https://b.com/p/9",
      company: "ACME",
      title: "backend  engineer",
      location: "Leeds",
    });
    expect(one).toEqual(["u:a.com/jobs/1", "j:acme|backend engineer|leeds"]);
    expect(isSeen(new Set(one), two)).toBe(true);
    expect(fingerprints({ url: "https://c.com/x" })).toEqual(["u:c.com/x"]);
  });

  it("tells employers apart on job systems that host many companies", () => {
    expect(employerSite("https://job-boards.greenhouse.io/gitlab/jobs/1")).toBe(
      "job-boards.greenhouse.io/gitlab",
    );
    expect(employerSite("https://jobs.lever.co/Acme/abc")).toBe("jobs.lever.co/acme");
    expect(employerSite("https://acme.wd5.myworkdayjobs.com/careers/job/1")).toBe(
      "acme.wd5.myworkdayjobs.com",
    );
    expect(employerSite("https://www.uk.indeed.com/viewjob?jk=1")).toBe("uk.indeed.com");
  });

  it("remembers the newest, up to a limit", () => {
    expect(remember(["a", "b"], ["b", "c", "d"], 3)).toEqual(["b", "c", "d"]);
  });
});

describe("the reading ladder", () => {
  it("accepts a page that loaded", () => {
    expect(judge(page())).toEqual({ kind: "ok" });
  });

  it("steps down for a shell, a JavaScript notice or a cookie wall", () => {
    expect(judge(page({ text: "Loading…" })).kind).toBe("step_down");
    expect(judge(page({ scriptRendered: true })).kind).toBe("step_down");
    expect(
      judge(page({ text: `Please enable JavaScript to continue. ${"x ".repeat(MIN_PAGE_CHARS)}` })).kind,
    ).toBe("step_down");
    expect(judge(page({ text: `We use cookies. Accept all cookies? ${"x ".repeat(300)}` })).kind).toBe(
      "step_down",
    );
  });

  it("hands a CAPTCHA or a sign-in wall to you", () => {
    expect(judge(page({ humanCheck: true })).kind).toBe("needs_you");
    expect(judge(page({ text: "Sign in to view this job" })).kind).toBe("needs_you");
  });

  it("gives up on a page that doesn't exist", () => {
    expect(judge(page({ status: 404 })).kind).toBe("gone");
  });

  it("tries readers cheapest first, starting where the site needed last time", () => {
    expect(readersFor({ api: false, visual: true })).toEqual(["text", "browser", "visual", "you"]);
    expect(readersFor({ api: true, visual: false })).toEqual(["api", "text", "browser", "you"]);
    expect(readersFor({ api: false, visual: true, noted: "browser" })).toEqual(["browser", "visual", "you"]);
    expect(readersFor({ api: false, visual: false, noted: "visual" })).toEqual(["text", "browser", "you"]);
  });
});

describe("leads", () => {
  it("knows career sites, job sites and the rest", () => {
    expect(leadKind("https://boards.greenhouse.io/acme/jobs/1")).toBe("career_site");
    expect(leadKind("https://uk.indeed.com/viewjob?jk=1")).toBe("job_site");
    expect(leadKind("https://acme.com/careers")).toBe("other");
  });

  it("drops results that can't be a job", () => {
    expect(looksLikeJob("https://acme.com/careers/backend")).toBe(true);
    expect(looksLikeJob("https://jobs.acme.com/1234")).toBe(true);
    expect(looksLikeJob("https://acme.com/blog/hiring-tips")).toBe(false);
    expect(looksLikeJob("https://www.youtube.com/watch?v=jobs")).toBe(false);
    expect(looksLikeJob("https://acme.com/about")).toBe(false);
  });

  it("never follows links on job sites that forbid automated reading", () => {
    expect(mayFollowLinks("https://www.linkedin.com/jobs/search")).toBe(false);
    expect(mayFollowLinks("https://boards.greenhouse.io/acme")).toBe(true);
  });

  it("puts career sites first and skips what was seen", () => {
    const picked = pickLeads(
      [
        "https://uk.indeed.com/viewjob?jk=1",
        "https://acme.com/careers/1",
        "https://jobs.lever.co/acme/0b4b8c2e-1d2f-4c3a-9f1e-123456789abc",
        "https://acme.com/careers/1?utm_source=bing",
        "https://seen.com/jobs/2",
      ],
      new Set(["u:seen.com/jobs/2"]),
    );
    expect(picked).toEqual([
      "https://jobs.lever.co/acme/0b4b8c2e-1d2f-4c3a-9f1e-123456789abc",
      "https://acme.com/careers/1",
      "https://uk.indeed.com/viewjob?jk=1",
    ]);
  });
});

describe("links", () => {
  it("reads links written into page text, resolving relative ones", () => {
    const links = linksFromText(
      "Backend Engineer (/jobs/1) and Designer (https://other.com/jobs/2) and again (/jobs/1)",
      "https://acme.com/careers",
    );
    expect(links).toEqual([
      { text: "Backend Engineer", url: "https://acme.com/jobs/1" },
      { text: "and Designer", url: "https://other.com/jobs/2" },
    ]);
  });

  it("keeps only addresses that really are links on the page", () => {
    const links = [{ text: "Backend", url: "https://acme.com/jobs/1" }];
    expect(linksOnPage(["https://www.acme.com/jobs/1/", "https://acme.com/jobs/999"], links)).toEqual([
      "https://acme.com/jobs/1",
    ]);
  });
});
