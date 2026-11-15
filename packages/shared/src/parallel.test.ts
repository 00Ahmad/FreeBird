import { describe, expect, it } from "vitest";

import type { MessagePart } from "./messages";
import { groupByLane, parallelInstructions, parseParallel } from "./parallel";
import { REAL_REPLIES } from "./parallel.fixtures";

const reply = [
  "## 1. Financial planner",
  "Buying ties up a deposit.",
  "",
  "## 2. Local estate agent",
  "Prices here rose 4% last year.",
  "",
  "## 3. Lifestyle coach",
  "Renting keeps you free to move.",
].join("\n");

describe("parseParallel", () => {
  it("splits a reply into its three roles", () => {
    expect(parseParallel(reply)).toEqual({
      before: "",
      sections: [
        { index: 1, role: "Financial planner", text: "Buying ties up a deposit." },
        { index: 2, role: "Local estate agent", text: "Prices here rose 4% last year." },
        { index: 3, role: "Lifestyle coach", text: "Renting keeps you free to move." },
      ],
    });
  });

  it("reads the headings models actually write", () => {
    for (const heading of [
      (n: number, role: string) => `### Agent ${n}: ${role}`,
      (n: number, role: string) => `## ${n} - ${role}`,
      (n: number, role: string) => `**${n}. ${role}**`,
      (n: number, role: string) => `# Bot ${n}) ${role}`,
      (n: number, role: string) => `## ${n}. <${role}>`,
    ]) {
      const text = [
        heading(1, "A one"),
        "first",
        heading(2, "B two"),
        "second",
        heading(3, "C three"),
        "third",
      ].join("\n");
      expect(
        parseParallel(text).sections.map((s) => [s.role, s.text]),
        heading(1, "A one"),
      ).toEqual([
        ["A one", "first"],
        ["B two", "second"],
        ["C three", "third"],
      ]);
    }
  });

  it("keeps what came before the first section, so no text is lost", () => {
    const parsed = parseParallel(`Sure, here are three views.\n\n${reply}`);
    expect(parsed.before).toBe("Sure, here are three views.");
    expect(parsed.sections).toHaveLength(3);
  });

  it("reads a reply that is still being written", () => {
    expect(parseParallel("")).toEqual({ before: "", sections: [] });
    expect(parseParallel("## 1. Fin").sections).toEqual([{ index: 1, role: "Fin", text: "" }]);
    const partway = parseParallel("## 1. Financial planner\nBuying ties up a deposit.\n\n## 2.");
    expect(partway.sections).toEqual([
      { index: 1, role: "Financial planner", text: "Buying ties up a deposit." },
      { index: 2, role: "", text: "" },
    ]);
  });

  it("leaves lists, deeper headings and code inside an answer alone", () => {
    const text = [
      "## 1. Engineer",
      "Steps:",
      "1. Back up",
      "2. Migrate",
      "### 2. A subheading that isn't a role",
      "```",
      "## 2. not a heading either",
      "```",
      "## 2. Auditor",
      "Check it.",
    ].join("\n");
    const { sections } = parseParallel(text);
    expect(sections.map((s) => s.role)).toEqual(["Engineer", "Auditor"]);
    expect(sections[0]!.text).toContain("1. Back up");
    expect(sections[0]!.text).toContain("### 2. A subheading that isn't a role");
    expect(sections[0]!.text).toContain("## 2. not a heading either");
  });

  it("only takes headings in order, so a model that skips or repeats one doesn't scramble the rest", () => {
    expect(parseParallel("## 2. Late\ntext").sections).toEqual([]);
    expect(parseParallel("## 2. Late\ntext").before).toBe("## 2. Late\ntext");
    const skipped = parseParallel("## 1. First\na\n## 3. Third\nc");
    expect(skipped.sections).toHaveLength(1);
    expect(skipped.sections[0]!.text).toContain("## 3. Third");
  });

  it("finds fewer than three sections when the model doesn't write three", () => {
    expect(parseParallel("## 1. Only\njust one").sections).toHaveLength(1);
    expect(parseParallel("Just an ordinary answer.").sections).toEqual([]);
  });
});

describe("parseParallel on what a real model wrote", () => {
  it.each(REAL_REPLIES)("splits the reply to: $question", ({ text }) => {
    const { before, sections } = parseParallel(text);
    expect(before).toBe("");
    expect(sections.map((section) => section.index)).toEqual([1, 2, 3]);
    for (const section of sections) {
      expect(section.role.length).toBeGreaterThan(2);
      expect(section.text.length).toBeGreaterThan(80);
    }
    expect(new Set(sections.map((section) => section.role)).size).toBe(3);
    // Reading it loses nothing: every word of the reply is in a heading or a section.
    const words = (value: string) =>
      value
        .replace(/[#\s.]+/g, " ")
        .trim()
        .split(" ")
        .filter((w) => !/^\d$/.test(w));
    const kept = sections.flatMap((section) => [section.role, section.text]).join(" ");
    expect(words(kept).length).toBe(words(text).length);
  });

  it("also reads such a reply while it is still arriving, a few characters at a time", () => {
    const { text } = REAL_REPLIES[0]!;
    let seen = 0;
    for (let end = 0; end <= text.length; end += 17) {
      const found = parseParallel(text.slice(0, end)).sections.length;
      // Sections only ever appear, never come and go as more text arrives.
      expect(found).toBeGreaterThanOrEqual(seen);
      seen = found;
    }
    expect(seen).toBe(3);
  });
});

describe("parallelInstructions", () => {
  it("asks for three headed sections in one reply, and names no fixed roles", () => {
    const text = parallelInstructions();
    expect(text).toContain("## 1. <role name>");
    expect(text).toContain("## 3. <role name>");
    expect(text).toContain("in this one reply");
    // The form it asks for is one its own reader accepts.
    const form = text.slice(text.indexOf("## 1."));
    expect(parseParallel(form).sections.map((s) => s.index)).toEqual([1, 2, 3]);
  });
});

describe("groupByLane", () => {
  it("keeps each lane's parts together, in order, and the rest apart", () => {
    const parts = [
      { type: "text", text: "note" },
      { type: "text", text: "a1", lane: 1 },
      { type: "tool", callId: "x", name: "web_search", args: {}, status: "done", lane: 2 },
      { type: "text", text: "a2", lane: 1 },
      { type: "error", code: "e", message: "m", lane: 3 },
    ] as MessagePart[];
    const { lanes, shared } = groupByLane(parts);
    expect(lanes.map((lane) => lane.length)).toEqual([2, 1, 1]);
    expect(lanes[0]!.map((p) => (p.type === "text" ? p.text : ""))).toEqual(["a1", "a2"]);
    expect(shared).toHaveLength(1);
  });

  it("treats a lane outside 1 to 3 or a part without one as shared", () => {
    const { lanes, shared } = groupByLane([{ type: "text", text: "x", lane: 4 } as unknown as MessagePart]);
    expect(lanes.flat()).toHaveLength(0);
    expect(shared).toHaveLength(1);
  });
});
