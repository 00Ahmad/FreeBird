import { describe, expect, it } from "vitest";

import { ANSWERS_ROOM, fitAnswers } from "./delegate-answers";

describe("helpers' answers handed back together", () => {
  it("keeps every helper's answer when five long ones don't fit", () => {
    const answers = ["A", "B", "C", "D", "E"].map((name) => ({
      name,
      text: `${name}:`.padEnd(6_000, "x") + "END",
    }));
    const out = fitAnswers(answers);
    // Before: the fourth was cut and the fifth lost under the 20,000-character cut.
    for (const name of ["A", "B", "C", "D", "E"]) expect(out).toContain(`## ${name}\n${name}:`);
    expect(out).toContain("E's full answer is in your conversation with E");
    expect(out.length).toBeLessThan(20_000);
  });

  it("keeps short answers whole and gives the room left to the long one", () => {
    const out = fitAnswers([
      { name: "Short", text: "£20" },
      { name: "Long", text: "y".repeat(ANSWERS_ROOM * 2) },
    ]);
    expect(out).toContain("## Short\n£20\n\n## Long");
    expect(out).toContain("Long's full answer");
    expect(out).not.toContain("Short's full answer");
  });

  it("leaves answers that fit as they are", () => {
    expect(
      fitAnswers([
        { name: "A", text: "one" },
        { name: "B", text: "two" },
      ]),
    ).toBe("## A\none\n\n## B\ntwo");
  });
});
