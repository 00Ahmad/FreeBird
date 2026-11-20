import { describe, expect, it } from "vitest";

import { currencyOf, periodOf, salaryVerdict, workplaceVerdict } from "./verdicts";

describe("verdicts code gives from confirmed facts", () => {
  it("settles the workplace", () => {
    expect(workplaceVerdict("Hybrid - 2 days in the office", ["remote"])).toMatchObject({
      verdict: "misses",
    });
    expect(workplaceVerdict("Fully remote", ["remote", "hybrid"])).toMatchObject({ verdict: "meets" });
    expect(workplaceVerdict("Leeds", ["remote"])).toBeNull();
    expect(workplaceVerdict(null, ["remote"])).toBeNull();
  });

  it("settles the salary when the currency and period are yours", () => {
    const floor = { amount: 50_000, currency: "GBP", period: "year" as const };
    expect(salaryVerdict("£45,000 – £48,000 per year", floor)).toMatchObject({ verdict: "misses" });
    expect(salaryVerdict("£45k-£55k a year", floor)).toMatchObject({ verdict: "meets" });
    // £60,000 with no period: a yearly salary.
    expect(salaryVerdict("£60,000", floor)).toMatchObject({ verdict: "meets" });
    // Another currency or period: left to the Checker.
    expect(salaryVerdict("$70,000 per year", floor)).toBeNull();
    expect(salaryVerdict("£25 per hour", floor)).toBeNull();
    expect(salaryVerdict("Competitive", floor)).toBeNull();
    expect(salaryVerdict("€60,000", { amount: 50_000, currency: "€", period: "year" })).toMatchObject({
      verdict: "meets",
    });
  });

  it("reads currencies and periods", () => {
    expect(currencyOf("C$80,000")).toBe("CAD");
    expect(currencyOf("$80,000")).toBe("USD");
    expect(periodOf("£30 an hour")).toBe("hour");
    expect(periodOf("£3,000 per month")).toBe("month");
    expect(periodOf("£40,000 p.a.")).toBe("year");
  });
});
