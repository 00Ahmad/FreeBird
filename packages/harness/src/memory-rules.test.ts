import { describe, expect, it } from "vitest";

import { estimateTextTokens } from "@mrog/engine";

import {
  alreadySaved,
  forgetProblem,
  memoryBudget,
  MEMORY_IN_PROMPT,
  noteMentions,
  notesForPrompt,
} from "./memory-rules";

describe("which memory notes go into the prompt", () => {
  it("keeps 60 full notes within a tenth of the default window, newest first, in saved order", () => {
    const notes = Array.from({ length: 60 }, (_, i) => `${i}`.padEnd(2000, "x"));
    const budget = memoryBudget(32_768);
    const { notes: kept, left } = notesForPrompt(notes, budget);
    // Before: all 60 went in, about 35,000 tokens, more than the whole window.
    expect(kept.reduce((sum, note) => sum + estimateTextTokens(note) + 1, 0)).toBeLessThanOrEqual(budget);
    expect(left).toBe(60 - kept.length);
    expect(kept.at(-1)).toBe(notes.at(-1));
    expect(kept).toEqual(notes.slice(notes.length - kept.length));
  });

  it("sends every short note up to the count limit", () => {
    const notes = Array.from({ length: 80 }, (_, i) => `Note ${i}`);
    const { notes: kept, left } = notesForPrompt(notes, memoryBudget(32_768));
    expect(kept).toHaveLength(MEMORY_IN_PROMPT);
    expect(left).toBe(20);
  });

  it("counts notes in other alphabets by what they cost, not by their length", () => {
    const urdu = Array.from({ length: 10 }, () => "ی".repeat(1_000));
    const latin = Array.from({ length: 10 }, () => "x".repeat(1_000));
    expect(notesForPrompt(urdu, memoryBudget(32_768)).notes.length).toBeLessThan(
      notesForPrompt(latin, memoryBudget(32_768)).notes.length,
    );
  });

  it("spots a note already saved, whatever its case, spacing or full stop", () => {
    expect(alreadySaved(["The user likes short answers."], "the user  likes short answers")).toBe(true);
    expect(alreadySaved(["The user likes short answers"], "The user likes long answers")).toBe(false);
  });
});

describe("forgetting notes", () => {
  it("refuses a word too short to name anything", () => {
    expect(forgetProblem("the")).not.toBeNull();
    expect(forgetProblem("a b")).not.toBeNull();
    expect(forgetProblem("tea")).not.toBeNull();
    expect(forgetProblem("metric units")).toBeNull();
  });

  it("matches whole words only", () => {
    expect(noteMentions("Likes green tea", "green tea")).toBe(true);
    expect(noteMentions("Prefers metric units", "Metric")).toBe(true);
    expect(noteMentions("Steady pace, metrical verse", "metric")).toBe(false);
  });
});

describe("how much memory a bot's prompt holds", async () => {
  const { memoryTokensFor } = await import("./team");
  const services = (local: boolean) =>
    ({
      runtime: { settings: { numCtx: 32_768, sharedModel: "ollama:qwen3.5:9b" } },
      registry: {
        resolve: (ref: string) => {
          if (ref.startsWith("gone:")) throw new Error("No provider");
          return { provider: { local: ref.startsWith("ollama:") ? local : false }, model: ref };
        },
      },
    }) as never;
  const bot = (model: string | null) => ({ model }) as never;

  it("is a tenth of the window on a local model", () => {
    expect(memoryTokensFor(services(true), bot(null))).toBe(memoryBudget(32_768));
  });

  it("keeps the old rule (60 notes, no token limit) on a cloud model, whose window is far larger", () => {
    expect(memoryTokensFor(services(true), bot("anthropic:claude-opus-5-5"))).toBe(Number.POSITIVE_INFINITY);
    expect(memoryTokensFor(services(true), bot("gone:model"))).toBe(Number.POSITIVE_INFINITY);
    const notes = Array.from({ length: 60 }, () => "x".repeat(2_000));
    expect(notesForPrompt(notes, Number.POSITIVE_INFINITY).notes).toHaveLength(60);
  });
});

describe("pinned notes", () => {
  it("always go into the prompt, however old, and the others fill the room left", () => {
    const notes = [
      { text: "My name is Sana", pinned: true },
      ...Array.from({ length: 60 }, (_, i) => ({ text: `${i}`.padEnd(2000, "x") })),
    ];
    const { notes: kept, pinnedOver } = notesForPrompt(notes, memoryBudget(32_768));
    // Before pinning, the oldest note was the first to be left out.
    expect(kept[0]).toEqual(notes[0]);
    expect(kept.at(-1)).toEqual(notes.at(-1));
    expect(pinnedOver).toBe(false);
  });

  it("are sent even past the budget, and say so", () => {
    const notes = [
      { text: "a".repeat(2000), pinned: true },
      { text: "b".repeat(2000), pinned: true },
      { text: "short" },
    ];
    const { notes: kept, pinnedOver } = notesForPrompt(notes, 600);
    expect(kept.map((note) => note.text[0])).toEqual(["a", "b"]);
    expect(pinnedOver).toBe(true);
  });

  it("keep two notes with the same text apart", () => {
    expect(notesForPrompt(["same", "same"], 600).notes).toEqual(["same", "same"]);
  });
});
