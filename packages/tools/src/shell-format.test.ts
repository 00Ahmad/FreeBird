import { describe, expect, it } from "vitest";

import { formatCommandResult } from "./shell";

describe("a command's output, as the model reads it", () => {
  it("cuts long output from the front with a plain ellipsis, not garbled text", () => {
    const text = formatCommandResult(
      { exitCode: 0, output: `${"x".repeat(20_000)}END`, timedOut: false },
      60,
    );
    expect(text.startsWith("…(earlier output cut)\n")).toBe(true);
    expect(text).not.toContain("â");
    expect(text).toContain("END");
  });
});
