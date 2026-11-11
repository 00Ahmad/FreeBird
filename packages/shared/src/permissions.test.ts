import { describe, expect, it } from "vitest";

import { PermissionRule, Permissions, ruleMatches } from "./permissions";

const saved = { id: "r1", tool: "fetch_url", match: "Fetch http://192.168.1.1", decision: "allow" };
const when = "2026-01-01T00:00:00.000Z";

describe("permission rules", () => {
  it("still reads a rule saved before exact existed, as a prefix rule", () => {
    const rule = PermissionRule.parse({ ...saved, createdAt: when });
    expect(rule.exact).toBeUndefined();
    expect(ruleMatches(rule, "Fetch http://192.168.1.1")).toBe(true);
    expect(ruleMatches(rule, "Fetch http://192.168.1.10/admin")).toBe(true);
    expect(
      Permissions.safeParse({ localExecution: "ask", rules: [{ ...saved, createdAt: when }] }).success,
    ).toBe(true);
  });

  it("keeps exact when a rule has it", () => {
    expect(PermissionRule.parse({ ...saved, exact: true, createdAt: when }).exact).toBe(true);
    expect(PermissionRule.safeParse({ ...saved, exact: "yes", createdAt: when }).success).toBe(false);
  });

  it("matches an exact rule only on the whole summary", () => {
    const exact = { match: "Fetch http://192.168.1.1", exact: true };
    expect(ruleMatches(exact, "Fetch http://192.168.1.1")).toBe(true);
    expect(ruleMatches(exact, "Fetch http://192.168.1.10/admin")).toBe(false);
    expect(ruleMatches(exact, "Fetch http://192.168.1.1:8080/x")).toBe(false);
    expect(ruleMatches({ match: "Write C:\\Users\\me\\a", exact: true }, "Write C:\\Users\\me\\a.ps1")).toBe(
      false,
    );
  });

  it("matches a typed rule by its start, and a rule with no text on anything", () => {
    expect(ruleMatches({ match: "git status", exact: false }, "git status --short")).toBe(true);
    expect(ruleMatches({ match: "git status" }, "git push")).toBe(false);
    expect(ruleMatches({ match: null }, "anything at all")).toBe(true);
  });
});
