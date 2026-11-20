import type { LeadSignal } from "@mrog/shared";
import { describe, expect, it } from "vitest";

import { daysBefore, parseDate } from "./dates";
import { generic } from "./playbooks/generic";
import { payroll } from "./playbooks/payroll";
import { SIGNALS, signalKind } from "./signals";
import { isStale, signalStrength, UNDATED_SHARE, whyNow } from "./signals/strength";

const NOW = new Date("2026-11-14T12:00:00Z");
const sign = (kind: LeadSignal["kind"], date: string | null): LeadSignal => ({
  kind,
  quote: "q",
  url: "https://example.test/",
  date,
  foundAt: NOW.toISOString(),
});

describe("signals", () => {
  it("each has its own id and a fresh period", () => {
    expect(new Set(SIGNALS.map((s) => s.id)).size).toBe(SIGNALS.length);
    for (const s of SIGNALS) expect(s.freshForDays).toBeGreaterThan(0);
  });

  it("accept only a quote that says the sign (code, not the model)", () => {
    expect(signalKind("funding").indicates("Brightside raised a £3m seed round", payroll)).toBe(true);
    expect(signalKind("funding").indicates("We love good food", payroll)).toBe(false);
    expect(signalKind("hiring").indicates("Payroll Administrator (12-month contract)", payroll)).toBe(true);
    expect(signalKind("hiring").indicates("Head Chef", payroll)).toBe(false);
    expect(signalKind("first_hire").indicates("We're hiring our first marketing hire", payroll)).toBe(true);
    expect(signalKind("expanding").indicates("We are opening our second restaurant in York", payroll)).toBe(
      true,
    );
    expect(signalKind("asking").indicates("We are seeking a payroll provider for 2027", payroll)).toBe(true);
    expect(signalKind("growing").indicates("We have 12 open roles", payroll)).toBe(true);
    expect(signalKind("unhappy").indicates("Fed up with our payroll company", payroll)).toBe(true);
  });

  it("don't pass ordinary sentences (1.1)", () => {
    const says = (kind: LeadSignal["kind"], quote: string, serviceNames?: string[]) =>
      signalKind(kind).indicates(quote, kind === "hiring" && serviceNames ? generic : payroll, {
        now: NOW,
        ...(serviceNames ? { serviceNames } : {}),
      });
    // Asking must name the service next to the asking words.
    expect(says("asking", "Slow cooked tender beef with roast potatoes")).toBe(false);
    expect(says("asking", "We recommend booking early for weekends")).toBe(false);
    expect(says("asking", "Can anyone recommend a good payroll bureau in Leeds?")).toBe(true);
    expect(says("asking", "Invitation to tender: payroll services for 300 staff")).toBe(true);
    expect(says("asking", "We are looking for an office cleaning company", ["office cleaning"])).toBe(true);
    expect(says("asking", "We are looking for a new head chef", ["office cleaning"])).toBe(false);
    // A new company needs a recent date, or "new", "just", "recently".
    expect(says("new_company", "Registered in England and Wales No. 01234567")).toBe(false);
    expect(says("new_company", "Established in 1987, family run")).toBe(false);
    expect(says("new_company", "Founded in March 2026 by two chefs")).toBe(true);
    expect(says("new_company", "We just opened our doors on Briggate")).toBe(true);
    // Funding needs money of a size or a round, and isn't a charity's.
    expect(says("funding", "Grant Thornton are our auditors")).toBe(false);
    expect(says("funding", "We raised £500 for the local hospice")).toBe(false);
    expect(says("funding", "Brightside secured £250k of investment to open two more sites")).toBe(true);
    expect(says("funding", "The startup closed a series A round")).toBe(true);
    // Hiring for a service with no job titles needs a hiring phrase, with word boundaries.
    expect(says("hiring", "Our role in the community matters to us", ["office cleaning"])).toBe(false);
    expect(says("hiring", "He is on parole", ["office cleaning"])).toBe(false);
    expect(says("hiring", "We're hiring: join our team as a site manager", ["office cleaning"])).toBe(true);
  });

  it("fade with age, count weakly when undated, and nothing past their fresh period", () => {
    const hiring = signalKind("hiring");
    expect(signalStrength(sign("hiring", daysBefore(NOW, 0)), NOW)).toBeCloseTo(hiring.strength);
    expect(signalStrength(sign("hiring", daysBefore(NOW, 60)), NOW)).toBeCloseTo(hiring.strength / 2);
    expect(signalStrength(sign("hiring", daysBefore(NOW, 61)), NOW)).toBe(0);
    expect(signalStrength(sign("hiring", null), NOW)).toBeCloseTo(hiring.strength * UNDATED_SHARE);
    expect(isStale(sign("hiring", daysBefore(NOW, 90)), NOW)).toBe(true);
    expect(isStale(sign("hiring", null), NOW)).toBe(false);
    // A date still to come (a deadline) is fresh.
    expect(signalStrength(sign("asking", "2027-01-01"), NOW)).toBe(1);
  });

  it("why-now: the strongest fresh sign, plus a little for each other one", () => {
    expect(whyNow([], NOW)).toBe(0);
    const fresh = daysBefore(NOW, 0);
    expect(whyNow([sign("funding", fresh)], NOW)).toBeCloseTo(0.6);
    expect(whyNow([sign("funding", fresh), sign("expanding", fresh)], NOW)).toBeCloseTo(0.7);
    expect(whyNow([sign("asking", fresh), sign("hiring", fresh)], NOW)).toBe(1);
  });
});

describe("dates", () => {
  it("reads the ways pages write them", () => {
    expect(parseDate("Posted 2026-11-03", NOW)).toBe("2026-11-03");
    expect(parseDate("on 03/11/2026", NOW)).toBe("2026-11-03");
    expect(parseDate("3rd November 2026", NOW)).toBe("2026-11-03");
    expect(parseDate("November 3, 2026", NOW)).toBe("2026-11-03");
    expect(parseDate("Sept 2026", NOW)).toBe("2026-09-01");
    expect(parseDate("2 weeks ago", NOW)).toBe("2026-10-31");
    expect(parseDate("yesterday", NOW)).toBe("2026-11-13");
    expect(parseDate("soon", NOW)).toBeNull();
    expect(parseDate("31/02/2026", NOW)).toBeNull();
    expect(parseDate("1066-10-14", NOW)).toBeNull();
  });
});
