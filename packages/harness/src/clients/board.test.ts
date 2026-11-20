import { emptyLists, emptyOffer } from "@mrog/clients";
import { MAX_LEADS, type ClientProject, type Lead, type LeadColumn } from "@mrog/shared";
import { describe, expect, it } from "vitest";

import { addLead } from "./board";

const lead = (id: string, column: LeadColumn, score = 60): Lead => ({
  id,
  kind: "signs",
  company: `Company ${id}`,
  domain: null,
  url: `https://${id}.test/`,
  site: `${id}.test`,
  readBy: "text",
  foundAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  scan: 1,
  column,
  facts: [],
  signals: [],
  evidence: [],
  records: [],
  contacts: [],
  fit: [],
  score,
  ownSite: false,
  summary: "",
  warnings: [],
  watch: false,
  checkedAt: "2026-11-01T00:00:00.000Z",
  movedUp: null,
  reaction: null,
  reason: null,
  note: "",
});

const board = (leads: Lead[]) =>
  ({ leads, lists: emptyLists(), profile: emptyOffer() }) as unknown as ClientProject;

describe("a full board (3.2)", () => {
  it("never drops a lead you're working", () => {
    const working = Array.from({ length: MAX_LEADS }, (_, i) => lead(`w${i}`, i % 2 ? "contacted" : "won"));
    const project = board(working);
    expect(addLead(project, lead("new", "new"))).toBe("full");
    expect(project.leads).toHaveLength(MAX_LEADS);
    expect(project.leads.some((l) => l.id === "new")).toBe(false);
  });

  it("drops a Not a fit lead first, then the weakest New one, only for a stronger lead", () => {
    const project = board([
      ...Array.from({ length: MAX_LEADS - 2 }, (_, i) => lead(`w${i}`, "contacted")),
      lead("nf", "not_a_fit"),
      lead("weak", "new", 30),
    ]);
    expect(addLead(project, lead("a", "new", 70))).toBe("added");
    expect(project.leads.some((l) => l.id === "nf")).toBe(false);
    expect(addLead(project, lead("b", "new", 20))).toBe("weaker");
    expect(project.leads.some((l) => l.id === "b")).toBe(false);
    expect(addLead(project, lead("c", "new", 80))).toBe("added");
    expect(project.leads.some((l) => l.id === "weak")).toBe(false);
    expect(project.leads).toHaveLength(MAX_LEADS);
  });
});
