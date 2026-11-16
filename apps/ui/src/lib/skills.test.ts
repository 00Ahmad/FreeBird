import { DEFAULT_BOT_TOOLS } from "@mrog/shared";
import { describe, expect, it } from "vitest";

import { canUseSkills, withSkills } from "./skills";

describe("Can use skills", () => {
  it("is on by default and switches both skill tools together", () => {
    expect(canUseSkills({ tools: DEFAULT_BOT_TOOLS })).toBe(true);
    const off = withSkills(DEFAULT_BOT_TOOLS, false);
    expect(off.exclude.toSorted()).toEqual(["find_skills", "use_skill"]);
    expect(canUseSkills({ tools: off })).toBe(false);
    expect(withSkills(off, true).exclude).toEqual([]);
  });

  it("keeps the bot's other switched-off tools", () => {
    const tools = { ...DEFAULT_BOT_TOOLS, exclude: ["run_command"] };
    expect(withSkills(tools, false).exclude).toEqual(["run_command", "find_skills", "use_skill"]);
    expect(withSkills(withSkills(tools, false), true).exclude).toEqual(["run_command"]);
  });
});
