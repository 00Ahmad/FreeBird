import { describe, expect, it } from "vitest";

import { checkFacts, factValue } from "../source-check";
import { greenhouse } from "./greenhouse";
import { JOB_SOURCES, sourceFor } from "./index";
import { lever } from "./lever";

const LEVER_ID = "0b4b8c2e-1d2f-4c3a-9f1e-123456789abc";

describe("job systems", () => {
  it("each has its own id", () => {
    expect(new Set(JOB_SOURCES.map((source) => source.id)).size).toBe(JOB_SOURCES.length);
  });

  it("know their addresses, and only theirs", () => {
    expect(sourceFor("https://boards.greenhouse.io/acme/jobs/123")?.apiUrl).toBe(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs/123",
    );
    expect(sourceFor("https://job-boards.greenhouse.io/acme")?.apiUrl).toBe(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
    );
    expect(sourceFor("https://boards.greenhouse.io/embed/job_app?for=acme&token=55")?.apiUrl).toBe(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs/55",
    );
    expect(sourceFor(`https://jobs.lever.co/acme/${LEVER_ID}`)?.apiUrl).toBe(
      `https://api.lever.co/v0/postings/acme/${LEVER_ID}`,
    );
    expect(sourceFor("https://jobs.eu.lever.co/acme")?.apiUrl).toBe(
      "https://api.eu.lever.co/v0/postings/acme?mode=json",
    );
    expect(sourceFor("https://acme.com/careers")).toBeNull();
    expect(sourceFor("https://boards.greenhouse.io/acme/departments/1")).toBeNull();
    expect(sourceFor("https://jobs.lever.co/acme/not-an-id")).toBeNull();
  });

  it("turn a Greenhouse posting into a page whose facts check out", () => {
    const url = "https://boards.greenhouse.io/acme/jobs/123";
    const page = greenhouse.toPage(
      {
        title: "Backend Engineer",
        company_name: "Acme Robotics",
        location: { name: "Leeds" },
        first_published: "2026-11-01T09:00:00Z",
        content:
          "&lt;p&gt;Salary: &amp;pound;55,000&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;",
      },
      url,
    )!;
    expect(page.text).toContain("Company: Acme Robotics\nLocation: Leeds\nPosted: 2026-11-01");
    expect(page.text).toContain("- Python");
    const checked = checkFacts(page.text, [
      { name: "title", value: "Backend Engineer", quote: "Backend Engineer" },
      { name: "company", value: "Acme Robotics", quote: "Company: Acme Robotics" },
    ]);
    expect(checked.confirmed).toBe(true);
    expect(factValue(checked.facts, "company")).toBe("Acme Robotics");
  });

  it("turn a Greenhouse board into a list of links", () => {
    const page = greenhouse.toPage(
      {
        jobs: [
          { title: "A", absolute_url: "https://boards.greenhouse.io/acme/jobs/1", location: { name: "X" } },
          { title: "B" },
        ],
      },
      "https://boards.greenhouse.io/acme",
    )!;
    expect(page.links).toEqual([{ text: "A", url: "https://boards.greenhouse.io/acme/jobs/1", place: "X" }]);
  });

  it("turn a Lever posting and board into pages", () => {
    const posting = lever.toPage(
      {
        text: "Data Analyst",
        categories: { location: "Remote, UK", commitment: "Full-time" },
        workplaceType: "remote",
        salaryRange: { currency: "GBP", interval: "per-year-salary", min: 40000, max: 50000 },
        descriptionPlain: "Join us.",
        lists: [{ text: "Requirements", content: "<li>SQL</li>" }],
      },
      `https://jobs.lever.co/acme/${LEVER_ID}`,
    )!;
    expect(posting.text).toContain("Company: acme");
    expect(posting.text).toContain("Workplace: Remote");
    expect(posting.text).toContain("Salary: 40000 - 50000 GBP per-year-salary");
    expect(posting.text).toContain("Requirements\n- SQL");
    const board = lever.toPage(
      [{ text: "Data Analyst", hostedUrl: `https://jobs.lever.co/acme/${LEVER_ID}` }],
      "https://jobs.lever.co/acme",
    )!;
    expect(board.links).toHaveLength(1);
  });

  it("refuse answers that aren't what was expected", () => {
    expect(greenhouse.toPage("nope", "https://boards.greenhouse.io/acme/jobs/1")).toBeNull();
    expect(lever.toPage({ jobs: [] }, "https://jobs.lever.co/acme")).toBeNull();
  });
});

describe("Ashby and SmartRecruiters, in the shapes their live answers have", async () => {
  const { ashby } = await import("./ashby");
  const { smartRecruiters } = await import("./smartrecruiters");
  const ID = "d3bc1ced-3ce4-4086-a050-555055dbb1ff";

  it("read an Ashby board, and find one posting in it", () => {
    const board = "https://jobs.ashbyhq.com/acme";
    expect(sourceFor(`${board}/${ID}`)?.apiUrl).toBe(
      "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true",
    );
    const json = {
      jobs: [
        {
          id: ID,
          title: "Backend Engineer",
          location: "Europe",
          isRemote: true,
          isListed: true,
          workplaceType: "Remote",
          employmentType: "FullTime",
          publishedAt: "2026-11-01T10:00:00+00:00",
          jobUrl: `${board}/${ID}`,
          descriptionPlain: "Build APIs.",
          compensation: { scrapeableCompensationSalarySummary: "€70K – €90K", compensationTierSummary: null },
        },
      ],
    };
    expect(ashby.toPage(json, board)!.links).toEqual([
      { text: "Backend Engineer", url: `${board}/${ID}`, place: "Europe (Remote)" },
    ]);
    const posting = ashby.toPage(json, `${board}/${ID}`)!;
    expect(posting.text).toContain("Workplace: Remote");
    expect(posting.text).toContain("Salary: €70K – €90K");
    expect(posting.text).toContain("Posted: 2026-11-01");
  });

  it("read a SmartRecruiters company's list and one posting", () => {
    const list = "https://jobs.smartrecruiters.com/AcmeGroup";
    const posting = "https://jobs.smartrecruiters.com/AcmeGroup/744000162770449--backend-engineer";
    expect(sourceFor(list)?.apiUrl).toBe(
      "https://api.smartrecruiters.com/v1/companies/AcmeGroup/postings?limit=100",
    );
    expect(sourceFor(posting)?.apiUrl).toBe(
      "https://api.smartrecruiters.com/v1/companies/AcmeGroup/postings/744000162770449",
    );
    const page = smartRecruiters.toPage(
      {
        content: [
          { id: "744000162770449", name: "Backend Engineer", location: { fullLocation: "Leeds, UK" } },
        ],
      },
      list,
    )!;
    expect(page.links[0]).toEqual({
      text: "Backend Engineer",
      url: "https://jobs.smartrecruiters.com/AcmeGroup/744000162770449",
      place: "Leeds, UK",
    });
    const one = smartRecruiters.toPage(
      {
        name: "Backend Engineer",
        company: { name: "Acme Group" },
        location: { fullLocation: "Leeds, UK", remote: false, hybrid: true },
        releasedDate: "2026-11-20T15:57:24.284Z",
        compensation: { min: 50000, max: 60000, currency: "GBP", period: "YEARLY" },
        jobAd: { sections: { jobDescription: { title: "The role", text: "<p>Build APIs.</p>" } } },
      },
      posting,
    )!;
    expect(one.text).toContain("Company: Acme Group");
    expect(one.text).toContain("Workplace: Hybrid");
    expect(one.text).toContain("Salary: 50000 - 60000 GBP per year");
    expect(one.text).toContain("Build APIs.");
  });

  it("give a Lever posting its date", () => {
    const page = lever.toPage(
      { text: "Data Analyst", createdAt: Date.parse("2026-08-31T18:12:19Z") },
      `https://jobs.lever.co/acme/${LEVER_ID}`,
    )!;
    expect(page.text).toContain("Posted: 2026-08-31");
  });
});
