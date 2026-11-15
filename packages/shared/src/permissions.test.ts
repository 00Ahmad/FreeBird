import { describe, expect, it } from "vitest";

import { PermissionRule, Permissions, ruleMatches, runsMore } from "./permissions";

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

  it("for a command, matches a typed rule only when nothing more is chained after its start", () => {
    const npm = { match: "npm" };
    const matches = (command: string) => ruleMatches(npm, command, { command });
    expect(matches("npm install lodash")).toBe(true);
    expect(matches("npm")).toBe(true);
    expect(matches("npm i; rm -rf ~")).toBe(false);
    expect(matches("npm i && x")).toBe(false);
    expect(matches("npm i | iex")).toBe(false);
    expect(matches("npm i\nx")).toBe(false);
    expect(matches("npm i $(x)")).toBe(false);
    expect(matches("npm i -EncodedCommand ZQB4AA==")).toBe(false);
    expect(matches("git status")).toBe(false);
    // What the rule's own text holds was typed by the user, so it counts as allowed.
    expect(
      ruleMatches({ match: "npm i && npm test" }, "npm i && npm test --ci", {
        command: "npm i && npm test --ci",
      }),
    ).toBe(true);
    expect(ruleMatches({ match: null }, "ls; rm x", { command: "ls; rm x" })).toBe(false);
    // Exact rules and other actions are unchanged.
    expect(ruleMatches({ match: "a; b", exact: true }, "a; b", { command: "a; b" })).toBe(true);
    expect(ruleMatches(npm, "npm i; rm -rf ~")).toBe(true);
    expect(runsMore(" install lodash@^4.17.0 --save-dev")).toBe(false);
    expect(runsMore(" -D eslint --save-exact")).toBe(false);
  });
});
