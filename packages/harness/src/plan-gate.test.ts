import { describe, expect, it } from "vitest";

import { skipPlan } from "./plan-gate";

describe("when the coordinator's model is asked whether a job splits into parts", () => {
  it("asks for a message that names several things to look into", () => {
    for (const text of [
      "Compare Flask, FastAPI and Django: latest version and async support for each.",
      "Find the price of the iPhone 16, the Pixel 9 and the Galaxy S25 on their makers' sites",
      "What are the opening hours of the museums in Leeds, York and Bradford this weekend?",
      "Check these sites for a returns policy:\n- shop-a.com\n- shop-b.com\n- shop-c.com",
    ])
      expect(skipPlan(text), text).toBeNull();
  });

  it("doesn't ask for a message that points back at the chat, since helpers couldn't see what it means", () => {
    expect(skipPlan("Now compare those three and check each one's returns policy please")).toBe(
      "points back at the chat",
    );
    expect(skipPlan("Look up the same details for every phone you found earlier")).toBe(
      "points back at the chat",
    );
  });

  it("doesn't ask for quick messages, files, or writing and explaining", () => {
    expect(skipPlan("thanks!")).toBe("short");
    expect(skipPlan("Use two helpers to list fruits and vegetables for me, please.")).toBe(
      "asks for helpers",
    );
    expect(skipPlan("Read report.md and compare each section with the notes in plan.txt")).toBe(
      "names a file",
    );
    expect(skipPlan("Write a short comparison of Python, Go and Rust for a beginner")).toBe(
      "one piece of work",
    );
    expect(skipPlan("Find me a good Italian restaurant near the station for tonight")).toBe("one thing");
  });
});
