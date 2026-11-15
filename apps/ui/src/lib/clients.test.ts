import type { ClientProject, Lead, OfferProfile } from "@mrog/shared";
import { describe, expect, it } from "vitest";

import { leadsTeam, teamParentOf } from "./codingTeam";
import {
  ageText,
  boardColumns,
  clientComposer,
  kindsFrom,
  leadLine,
  offerChange,
  sizeFrom,
  statusLine,
} from "./clients";

const NOW = new Date("2026-11-14T12:00:00Z");
const lead = (over: Partial<Lead>): Lead => ({
  id: "l",
  kind: "signs",
  company: "Brightside Kitchens",
  domain: "brightside-kitchens.test",
  url: "https://brightside-kitchens.test/",
  site: "brightside-kitchens.test",
  readBy: "text",
  foundAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  scan: 1,
  column: "new",
  facts: [],
  signals: [],
  evidence: [],
  records: [],
  contacts: [],
  fit: [],
  score: 60,
  ownSite: true,
  summary: "",
  warnings: [],
  watch: false,
  checkedAt: NOW.toISOString(),
  movedUp: null,
  reaction: null,
  reason: null,
  note: "",
  ...over,
});

describe("the Client Bot's screen", () => {
  it("orders each column: asking now, then signs, then quiet fits", () => {
    const columns = boardColumns([
      lead({ id: "q", kind: "quiet", score: 70 }),
      lead({ id: "s", kind: "signs", score: 55 }),
      lead({ id: "a", kind: "asking", score: 52 }),
      lead({ id: "x", column: "won" }),
    ]);
    expect(columns[0]!.leads.map((l) => l.id)).toEqual(["a", "s", "q"]);
    expect(columns.find((c) => c.column === "won")!.leads).toHaveLength(1);
  });

  it("says each lead's strongest sign with its age, or its trait", () => {
    expect(ageText("2026-11-02", NOW)).toBe("12 days ago");
    expect(ageText("2026-11-14", NOW)).toBe("today");
    expect(ageText("2026-11-19", NOW)).toBe("in 5 days");
    const signed = lead({
      signals: [{ kind: "hiring", quote: "q", url: "u", date: "2026-11-02", foundAt: NOW.toISOString() }],
    });
    expect(leadLine(signed, NOW)).toBe("Hiring for your work · 12 days ago");
    const quiet = lead({
      kind: "quiet",
      facts: [{ name: "size", value: "30 staff", quote: "x" }],
      evidence: [{ kind: "trait", id: "multi_site", quote: "q", url: "u" }],
    });
    expect(leadLine(quiet, NOW)).toBe("30 staff · More than one site");
  });

  it("status lines and the composer", () => {
    const project = {
      status: "scanning",
      scan: { number: 2, found: 1, target: 5, pagesRead: 9 },
      note: null,
      handoff: null,
    } as unknown as ClientProject;
    expect(statusLine(project)).toBe("Scan 2: 1 of 5 new leads (9 pages and records read)");
    expect(clientComposer(project, "Finder").placeholder).toBe('Say "stop" to end the scan');
  });

  it("sends only what changed on the profile card", () => {
    const saved = { offer: "Payroll", areas: ["Leeds"], sizeMax: null } as unknown as OfferProfile;
    expect(offerChange(saved, { ...saved, areas: ["Leeds", "York"] })).toEqual({ areas: ["Leeds", "York"] });
    expect(offerChange(saved, saved)).toBeNull();
    expect([sizeFrom(""), sizeFrom("50"), sizeFrom("-1"), sizeFrom("x")]).toEqual([null, 50, "bad", "bad"]);
    expect(kindsFrom({ asking: true, signs: false, quiet: true })).toEqual(["asking", "quiet"]);
  });

  it("counts a Client Bot as a team, and its roles as its team's", () => {
    expect(leadsTeam({ coding: false, job: false, client: true })).toBe(true);
    const bots = [{ id: "c", parentId: null, coding: false, job: false, client: true }];
    expect(teamParentOf({ parentId: "c" }, bots)?.id).toBe("c");
  });
});
