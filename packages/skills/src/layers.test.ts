import { describe, expect, it } from "vitest";

import { mergeSkills } from "./index";

const skill = (name: string, from: string) => ({ name, from });

describe("a bot's skills in layers", () => {
  it("keeps every name once, the most specific layer winning, ignoring case", () => {
    const merged = mergeSkills([
      [skill("code-review", "role")],
      [skill("Code-Review", "team"), skill("tests", "team")],
      [skill("code-review", "shared"), skill("tests", "shared"), skill("debug", "shared")],
    ]);
    expect(merged).toEqual([skill("code-review", "role"), skill("debug", "shared"), skill("tests", "team")]);
  });

  it("is empty with no layers or only empty ones", () => {
    expect(mergeSkills([])).toEqual([]);
    expect(mergeSkills([[], []])).toEqual([]);
  });
});
