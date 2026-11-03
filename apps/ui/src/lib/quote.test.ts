import { describe, expect, it } from "vitest";

import { quoteInto } from "./quote";

describe("quoting a selection", () => {
  it("quotes every line and leaves a blank line to write under", () => {
    expect(quoteInto("", "  First line\n\nSecond  \n")).toBe("> First line\n>\n> Second\n\n");
  });

  it("goes after what was already typed", () => {
    expect(quoteInto("About this:  ", "the plan")).toBe("About this:\n\n> the plan\n\n");
  });

  it("leaves the draft alone for an empty selection", () => {
    expect(quoteInto("draft", " \n ")).toBe("draft");
  });
});
