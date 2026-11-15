import { describe, expect, it } from "vitest";

import type { Message, MessagePart } from "@mrog/shared";

import {
  clipForLane,
  FALLBACK_ROLES,
  forHistory,
  laneAnswersText,
  laneHeader,
  laneKnownLinks,
  laneNote,
  memoryWarning,
  parseRoles,
  plainLaneNote,
  readLaneHeader,
  rolesRequest,
} from "./parallel-lanes";

const names = (text: string) => parseRoles(text).map((r) => r.role);

describe("parseRoles", () => {
  it("reads numbered lines with a focus after a bar, a colon or a dash", () => {
    expect(
      parseRoles(
        "1. Financial planner | the ten-year cost\n2. Estate agent: the local market\n3. Coach - daily life",
      ),
    ).toEqual([
      { role: "Financial planner", focus: "the ten-year cost" },
      { role: "Estate agent", focus: "the local market" },
      { role: "Coach", focus: "daily life" },
    ]);
  });

  it("reads bullets, bold, brackets, quotes and a thinking block", () => {
    const text =
      '<think>1. Wrong | thought</think>\n- **Security engineer** | the risks\n* "Skeptic": what fails\n3) <Historian> | precedent';
    expect(parseRoles(text)).toEqual([
      { role: "Security engineer", focus: "the risks" },
      { role: "Skeptic", focus: "what fails" },
      { role: "Historian", focus: "precedent" },
    ]);
  });

  it("reads a JSON list", () => {
    const json =
      '```json\n[{"role": "A", "focus": "a"}, {"name": "B", "focus": "b"}, {"role": "C", "focus": "c"}]\n```';
    expect(names(json)).toEqual(["A", "B", "C"]);
  });

  it("fills what is missing from the fallback roles, and uses them all when nothing can be read", () => {
    expect(names("1. Only one | focus")).toEqual(["Only one", "Analyst", "Critic"]);
    expect(parseRoles("I am not sure what you mean!")).toEqual(FALLBACK_ROLES);
    expect(parseRoles("")).toEqual(FALLBACK_ROLES);
  });

  it("takes three at most and no role twice", () => {
    expect(names("1. A | a\n2. a | again\n3. B | b\n4. C | c\n5. D | d")).toEqual(["A", "B", "C"]);
  });

  it("asks for three lines in the form it reads", () => {
    const request = rolesRequest("  Should I buy a flat?  ");
    expect(request.user).toBe("Should I buy a flat?");
    expect(request.system).toContain("1. <role name in two to four words> | <one line");
    expect(parseRoles(request.system.split("Example")[1]!.split("\n").slice(1, 4).join("\n"))).toHaveLength(
      3,
    );
  });
});

describe("the lane note and heading", () => {
  it("tells a role who it is, what it may use and how long, and that two others exist", () => {
    const note = laneNote({
      index: 2,
      role: "Skeptic",
      focus: "what fails",
      tools: ["web_search", "fetch_url"],
      steps: 6,
    });
    expect(note).toContain("role 2 of 3");
    expect(note).toContain("You are the Skeptic. Your focus: what fails.");
    expect(note).toContain("web_search and fetch_url only when you need facts, at most 6 steps");
    expect(note).toContain("Two other roles");
    expect(laneNote({ index: 1, role: "A", focus: "b", tools: [], steps: 6 })).toContain("You have no tools");
  });

  it("round-trips the heading", () => {
    expect(readLaneHeader(laneHeader(3, "Cost analyst", "the money"))).toEqual({
      index: 3,
      role: "Cost analyst",
      focus: "the money",
    });
    expect(readLaneHeader("just some text")).toBeNull();
    expect(readLaneHeader("## 4. Nope")).toBeNull();
  });
});

const lanes: MessagePart[] = [
  { type: "text", lane: 1, text: laneHeader(1, "Cost analyst", "money") },
  { type: "text", lane: 2, text: laneHeader(2, "Security", "risks") },
  { type: "text", lane: 3, text: laneHeader(3, "Skeptic", "doubt") },
  {
    type: "tool",
    lane: 1,
    callId: "L1-a",
    name: "web_search",
    args: { query: "q" },
    status: "done",
    result: "SECRET RESULT https://one.example/a",
  },
  { type: "reasoning", lane: 1, text: "private thoughts" },
  { type: "text", lane: 1, text: "Buying costs more." },
  { type: "text", lane: 2, text: "Patch your servers." },
  { type: "error", lane: 3, code: "x", message: "down" },
];

describe("what goes back to the model", () => {
  it("keeps each role's final answer under its role and drops searches, reasoning, headings and empty roles", () => {
    expect(laneAnswersText(lanes)).toBe(
      "## Cost analyst\nBuying costs more.\n\n## Security\nPatch your servers.",
    );
  });

  it("replaces any reply written by lanes, with tools or without, and nothing else", () => {
    const message = (parallelTools: boolean, parts: MessagePart[] = lanes): Message =>
      ({ id: "m", role: "bot", parallel: true, parallelTools, parts, status: "done" }) as unknown as Message;
    const [tools] = forHistory([message(true)]);
    expect(tools!.parts).toEqual([{ type: "text", text: laneAnswersText(lanes) }]);
    // A cloud reply whose roles ran as separate requests without tools has lanes too.
    const [separate] = forHistory([message(false)]);
    expect(separate!.parts).toEqual([{ type: "text", text: laneAnswersText(lanes) }]);
    // The one-request reply (three sections in one text, no lanes) goes back as written.
    const sections: MessagePart[] = [{ type: "text", text: "## 1. A\nx\n\n## 2. B\ny" }];
    expect(forHistory([message(false, sections)])[0]!.parts).toBe(sections);
    const user = { id: "u", role: "user", parallelTools: true, parts: lanes } as unknown as Message;
    expect(forHistory([user])[0]!.parts).toBe(lanes);
  });
});

describe("a role's known links", () => {
  it("are those in its own searches and pages, and in what the user wrote, and no others", () => {
    const own = lanes.filter((part) => "lane" in part && part.lane === 1);
    const known = laneKnownLinks(own, "see https://user.example/x.");
    expect(known.has("https://one.example/a")).toBe(true);
    expect(known.has("https://user.example/x")).toBe(true);
    expect(known.has("https://two.example/b")).toBe(false);
  });
});

describe("memoryWarning", () => {
  const model = { name: "m", sizeBytes: 1000, vramBytes: 1000, contextLength: 8192, expiresAt: null };

  it("fires when part of the model runs on the CPU, with the fix", () => {
    const warning = memoryWarning({ lanes: 3, loaded: { ...model, vramBytes: 400 }, numCtx: 8192 })!;
    expect(warning).toContain("three roles write at the same time");
    expect(warning).toContain(
      "the model isn't fully on the GPU (40% of it is, with a context of 8,192 tokens)",
    );
    expect(warning).toContain("use a smaller context in Settings → Local model");
    expect(warning).toContain("OLLAMA_NUM_PARALLEL to 3");
    expect(memoryWarning({ lanes: 2, loaded: { ...model, vramBytes: 900 }, numCtx: 8192 })).toContain(
      "2 roles",
    );
  });

  it("doesn't fire for a large context that fits on the GPU, or within the tolerance", () => {
    expect(memoryWarning({ lanes: 3, loaded: model, numCtx: 32768 })).toBeNull();
    expect(
      memoryWarning({ lanes: 3, loaded: { ...model, contextLength: 131072 }, numCtx: 131072 }),
    ).toBeNull();
    expect(memoryWarning({ lanes: 3, loaded: { ...model, vramBytes: 985 }, numCtx: 32768 })).toBeNull();
  });

  it("doesn't fire with one lane, or for a model nothing is known about (a cloud one)", () => {
    expect(memoryWarning({ lanes: 1, loaded: { ...model, vramBytes: 10 }, numCtx: 8192 })).toBeNull();
    expect(memoryWarning({ lanes: 3, loaded: undefined, numCtx: 32768 })).toBeNull();
    expect(
      memoryWarning({ lanes: 3, loaded: { ...model, sizeBytes: 0, vramBytes: 0 }, numCtx: 8192 }),
    ).toBeNull();
  });
});

describe("clipForLane", () => {
  it("cuts a long page and says how much", () => {
    expect(clipForLane("short")).toBe("short");
    const clipped = clipForLane("x".repeat(5000));
    expect(clipped.length).toBeLessThan(4200);
    expect(clipped).toContain("(cut: 1000 more characters)");
  });
});

describe("plainLaneNote", () => {
  it("names the role and its focus and says nothing about tools or steps", () => {
    const note = plainLaneNote({ index: 3, role: "Skeptic", focus: "what fails" });
    expect(note).toBe(
      "(Parallel Bots, role 3 of 3. You are the Skeptic. Your focus: what fails. Two other roles are answering the same message separately. You can't see them, so don't mention them or repeat what they might say. Write your complete answer from this role's point of view, as long as the message needs. Don't write a heading or the role name: the app adds them.)",
    );
    expect(note).not.toMatch(/tool|step|web_search|fetch_url|results/);
  });
});
