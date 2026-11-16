import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { Skill } from "@mrog/shared";
import { describe, expect, it } from "vitest";

import { BUILTIN_SKILLS, findSkills, skillsPromptLine, whatFor } from "./index";

describe("the built-in skills", () => {
  it("are 30 to 40 or more, each with a unique valid name, a description and a prompt", () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(BUILTIN_SKILLS.map((s) => s.name)).size).toBe(BUILTIN_SKILLS.length);
    for (const skill of BUILTIN_SKILLS) {
      const parsed = Skill.safeParse({ ...skill, id: "x", botId: null, createdAt: new Date().toISOString() });
      expect(parsed.success, skill.name).toBe(true);
      expect(skill.description.length, skill.name).toBeGreaterThan(20);
      expect(skill.description.length, skill.name).toBeLessThanOrEqual(400);
    }
  });

  it("are written to one standard: a role, rules, an output format and a final checklist", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.prompt, skill.name).toMatch(/^# /);
      expect(skill.prompt, skill.name).toMatch(/^You are /m);
      expect(skill.prompt, skill.name).toContain("## Rules");
      expect(skill.prompt, skill.name).toContain("## Output");
      expect(skill.prompt, skill.name).toContain("## Check before you finish");
      expect(skill.description, skill.name).toMatch(/Use when /);
    }
  });

  it("never tell a bot to send anything for the user", () => {
    for (const skill of BUILTIN_SKILLS)
      expect(skill.prompt, skill.name).not.toMatch(/\b(send|post) it (for|on behalf)/i);
  });
});

describe("finding a skill", () => {
  it("matches by name, then description", () => {
    expect(findSkills(BUILTIN_SKILLS, "review my code for bugs")[0]!.name).toBe("code-review");
    expect(findSkills(BUILTIN_SKILLS, "summarise this long report")[0]!.name).toBe("summarize");
    expect(findSkills(BUILTIN_SKILLS, "write tests")[0]!.name).toBe("write-tests");
    expect(findSkills(BUILTIN_SKILLS, "excel formula")[0]!.name).toBe("spreadsheet-formula");
    expect(findSkills(BUILTIN_SKILLS, "zzqq")).toEqual([]);
  });

  it("lists them all by name for an empty query, at most `max`", () => {
    expect(findSkills(BUILTIN_SKILLS, "", 3).map((s) => s.name)).toEqual(
      BUILTIN_SKILLS.map((s) => s.name)
        .toSorted()
        .slice(0, 3),
    );
  });

  it("describes a skill without a description by the start of its prompt", () => {
    expect(whatFor({ name: "x", description: "", prompt: "Do the  thing\nwell" })).toBe("Do the thing well");
  });

  it("tells a bot it has skills by name only", () => {
    expect(skillsPromptLine([])).toBeNull();
    expect(skillsPromptLine(["a", "b"])).toMatch(/\(a, b\)\..*use_skill.*find_skills/);
  });
});

describe("the skills package boundary", () => {
  it("imports nothing that reaches the outside world", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
      });
    const wrong: string[] = [];
    for (const file of files(import.meta.dirname)) {
      if (file.endsWith(".test.ts")) continue;
      for (const m of readFileSync(file, "utf8").matchAll(
        /(?:^|[\s;{}])(?:from|import)\s*\(?\s*["']([^"']+)["']/gm,
      ))
        if (!/^(\.{1,2}\/|@mrog\/shared$)/.test(m[1]!)) wrong.push(`${file}: ${m[1]}`);
    }
    expect(wrong).toEqual([]);
  });
});
