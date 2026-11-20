import { describe, expect, it } from "vitest";

import { JobProfile, type JobCard, type JobProject } from "@mrog/shared";

import { botActions, isTeamBot, isTeamThread, teamParentOf } from "./codingTeam";
import {
  boardColumns,
  canScan,
  cardCompany,
  cardTitle,
  isNew,
  jobComposer,
  listFrom,
  profileChange,
  scanTarget,
  statusLine,
  suggestedTarget,
  uncheckedLine,
} from "./jobs";

const card = (over: Partial<JobCard> = {}): JobCard => ({
  id: "c1",
  url: "https://jobs.example.test/1",
  site: "jobs.example.test",
  readBy: "text",
  foundAt: "2026-11-14T10:00:00.000Z",
  scan: 1,
  column: "found",
  facts: [
    { name: "title", value: "Backend Engineer", quote: "Backend Engineer" },
    { name: "company", value: null, quote: null },
  ],
  summary: "",
  match: [],
  score: 60,
  warnings: [],
  company: [],
  reaction: null,
  reason: null,
  unchecked: 0,
  ...over,
});

const project = (over: Partial<JobProject> = {}): JobProject =>
  ({
    botId: "bot_1",
    status: "ready",
    profile: JobProfile.parse({}),
    cards: [],
    scan: null,
    lastTarget: 7,
    note: null,
    handoff: null,
    suggestions: [],
    ...over,
  }) as JobProject;

describe("the Job Bot's screen", () => {
  it("lays the board out in column order, best match first", () => {
    const columns = boardColumns([
      card({ id: "a", score: 40 }),
      card({ id: "b", score: 90 }),
      card({ id: "c", column: "applied" }),
    ]);
    expect(columns.map((c) => c.column)).toEqual([
      "found",
      "shortlisted",
      "preparing",
      "applied",
      "interview",
      "offer",
      "rejected",
      "not_for_me",
    ]);
    expect(columns[0]!.cards.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("can sort newest first, and show only the latest scan's jobs", () => {
    const cards = [
      card({ id: "old", score: 90, scan: 1, foundAt: "2026-11-01T10:00:00.000Z" }),
      card({ id: "new", score: 55, scan: 2, foundAt: "2026-11-14T10:00:00.000Z" }),
      card({ id: "newer", score: 70, scan: 2, foundAt: "2026-11-14T11:00:00.000Z" }),
    ];
    expect(boardColumns(cards, { sort: "newest" })[0]!.cards.map((c) => c.id)).toEqual([
      "newer",
      "new",
      "old",
    ]);
    expect(boardColumns(cards, { onlyNew: true, latestScan: 2 })[0]!.cards.map((c) => c.id)).toEqual([
      "newer",
      "new",
    ]);
    // No scan yet: nothing counts as new.
    expect(boardColumns(cards, { onlyNew: true, latestScan: null })[0]!.cards).toEqual([]);
    expect(isNew(card({ scan: 2 }), project({ scan: { number: 2 } as JobProject["scan"] }))).toBe(true);
    expect(isNew(card({ scan: 1 }), project({ scan: { number: 2 } as JobProject["scan"] }))).toBe(false);
  });

  it("says when a card has requirements its last reading didn't check", () => {
    expect(uncheckedLine(card({ unchecked: 0 }))).toBeNull();
    expect(uncheckedLine(card({ unchecked: 1 }))).toBe(
      "1 newer requirement wasn't checked on this job: it was read before you added it.",
    );
    expect(uncheckedLine(card({ unchecked: 3 }))).toMatch(/^3 newer requirements weren't checked/);
  });

  it("names a card by its facts, with the site when the company isn't stated", () => {
    expect(cardTitle(card())).toBe("Backend Engineer");
    expect(cardCompany(card())).toBe("jobs.example.test");
  });

  it("says what the bot is doing", () => {
    const scan = {
      number: 2,
      target: 5,
      found: 1,
      weaker: 0,
      pagesRead: 4,
      visualPages: 0,
      searchRounds: 1,
      startedAt: "x",
      endedAt: null,
      stopReason: null,
    };
    expect(statusLine(project({ status: "scanning", scan }))).toBe("Scan 2: 1 of 5 new jobs (4 pages read)");
    expect(statusLine(project({ scan: { ...scan, endedAt: "y", stopReason: "Found 5 new jobs." } }))).toBe(
      "Last scan: Found 5 new jobs.",
    );
    expect(statusLine(project({ status: "awaiting_profile" }))).toMatch(/approve it/);
    expect(canScan(project({ status: "interview" }))).toBe(false);
    expect(jobComposer(project({ status: "interview" }), "Scout").placeholder).toBe(
      "Tell Scout about the job you want",
    );
  });

  it("asks for a whole number from 1 to 50, suggesting the last one", () => {
    expect(scanTarget("12")).toEqual({ target: 12 });
    expect(scanTarget("0")).toEqual({ problem: "Pick a number from 1 to 50." });
    expect(scanTarget("2.5")).toEqual({ problem: "Type a whole number." });
    expect(suggestedTarget(project())).toBe(7);
    expect(suggestedTarget(undefined)).toBe(10);
  });

  it("edits list fields one per line and sends only what changed", () => {
    expect(listFrom(" Python \n\nGo\n")).toEqual(["Python", "Go"]);
    const saved = JobProfile.parse({ titles: ["A"] });
    expect(profileChange(saved, saved)).toBeNull();
    expect(profileChange(saved, { ...saved, places: ["Leeds"] })).toEqual({ places: ["Leeds"] });
  });
});

describe("a Job Bot's team on the screen", () => {
  const bots = [
    { id: "job", parentId: null, coding: false, job: true },
    { id: "role", parentId: "job", coding: false, job: false },
    { id: "helper", parentId: "plain", coding: false },
    { id: "plain", parentId: null, coding: false },
  ];

  it("counts its roles as a team, like a Coding Bot's", () => {
    expect(teamParentOf(bots[1]!, bots)?.id).toBe("job");
    expect(isTeamBot(bots[1]!, bots)).toBe(true);
    expect(isTeamBot(bots[2]!, bots)).toBe(false);
    expect(isTeamThread({ pair: true, memberIds: ["job", "role"] }, bots)).toBe(true);
  });

  it("can't be copied or made primary; its roles can't be touched", () => {
    expect(botActions(bots[0]!, bots)).toMatchObject({ duplicate: false, makePrimary: false, delete: true });
    expect(botActions(bots[1]!, bots)).toMatchObject({ rename: false, delete: false });
  });
});
