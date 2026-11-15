import type { ClientFact } from "@mrog/shared";
import { describe, expect, it } from "vitest";

import { payroll } from "./playbooks/payroll";
import { LEAD_WARNINGS, leadWarnings, type LeadContext } from "./warnings";

const NOW = new Date("2026-11-14T12:00:00Z");
const facts = (over: Partial<Record<ClientFact["name"], string>>): ClientFact[] =>
  (["company", "website", "place", "size", "industry", "what"] as const).map((name) => ({
    name,
    value: over[name] ?? null,
    quote: over[name] ?? null,
  }));
const context = (over: Partial<LeadContext> = {}): LeadContext => ({
  facts: facts({ company: "Brightside Kitchens" }),
  signals: [],
  records: [],
  contacts: [{ kind: "email", value: "hello@b.test", url: "u" }],
  pages: "A restaurant group in Leeds.",
  playbook: payroll,
  now: NOW,
  ...over,
});
const ids = (over: Partial<LeadContext>) => leadWarnings(context(over)).map((w) => w.id);

describe("lead warnings", () => {
  it("each has its own id, and a clean lead has none", () => {
    expect(new Set(LEAD_WARNINGS.map((r) => r.id)).size).toBe(LEAD_WARNINGS.length);
    expect(leadWarnings(context())).toEqual([]);
  });

  it("stale signs and closed tenders", () => {
    const old = {
      kind: "hiring" as const,
      quote: "q",
      url: "u",
      date: "2026-01-01",
      foundAt: NOW.toISOString(),
    };
    expect(ids({ signals: [old] })).toEqual(["stale"]);
    const tender = { register: "x", id: "1", url: "u", label: "l", deadline: "2026-11-01", status: null };
    expect(leadWarnings(context({ records: [tender] }))[0]!.text).toBe("The tender closed on 2026-11-01.");
  });

  it("a closed company, a maybe-competitor, an agency post", () => {
    const dissolved = {
      register: "companies-house",
      id: "1",
      url: "u",
      label: "l",
      deadline: null,
      status: "dissolved",
    };
    expect(ids({ records: [dissolved] })).toEqual(["closed-company"]);
    expect(ids({ pages: "We offer payroll services to restaurants." })).toEqual(["maybe-competitor"]);
    expect(ids({ pages: "We are recruiting on behalf of our client." })).toEqual(["agency-post"]);
  });

  it("a big buyer, no contact route, a sole trader", () => {
    expect(ids({ facts: facts({ company: "X", size: "1,200 employees" }) })).toEqual(["big-buyer"]);
    expect(ids({ facts: facts({ company: "Leeds City Council" }) })).toEqual(["big-buyer"]);
    expect(ids({ contacts: [] })).toEqual(["no-contact"]);
    expect(ids({ pages: "I'm a sole trader based in Leeds." })).toEqual(["sole-trader"]);
  });
});
