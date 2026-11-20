import { describe, expect, it } from "vitest";

import { assignedSkillsSection, BUILTIN_SKILLS, pickAssigned } from "./index";

describe("assigned skills", () => {
  it("picks skills by name in the order given, ignoring case and unknown names", () => {
    const picked = pickAssigned(BUILTIN_SKILLS, ["Write-Tests", "nope", "code-review"]);
    expect(picked.map((skill) => skill.name)).toEqual(["write-tests", "code-review"]);
  });

  it("puts each skill's whole steps in the prompt, after saying the job's own rules come first", () => {
    const section = assignedSkillsSection([
      { name: "a", prompt: "Step one.\n" },
      { name: "b", prompt: "Step two." },
    ])!;
    expect(section).toContain("Skills assigned to you (a, b)");
    expect(section).toContain("Your own rules and tools come first");
    expect(section).toContain("=== Skill: a ===\nStep one.");
    expect(section).toContain("=== Skill: b ===\nStep two.");
    expect(assignedSkillsSection([])).toBeNull();
  });
});
