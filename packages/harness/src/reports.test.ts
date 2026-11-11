import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RUNTIME_SETTINGS,
  messageText,
  type Bot,
  type Discussion,
  type Race,
  type Thread,
} from "@mrog/shared";

import { summaryGaps } from "./discussion";
import { judgeGaps, topScorer } from "./race";
import { fitTexts, lastSection, mergeSections, sectionGaps } from "./reports";
import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const reply = (text: string, reason = "stop") =>
  ndjson([{ message: { content: text } }, { done: true, done_reason: reason }]);

const WHOLE_DECISION = [
  "## Discussion summary",
  "### Recommendation",
  "Open it, medium confidence.",
  "### Arguments for and against",
  "- For: demand. Against: rent.",
  "### Where they disagreed",
  "On the rent.",
  "### Sources cited",
  "None",
  "### What would change the recommendation",
  "A rent rise.",
].join("\n");

describe("report checks", () => {
  it("finds sections that are missing or empty, whatever the heading style", () => {
    const text =
      "## Discussion summary\n### Recommendation\nGo.\n**Arguments for and against**\n\n#### where they disagreed\nRent.\n### Sources cited\n(none given)";
    // "Go." is short but said; "(none given)" answers the sources section.
    expect(summaryGaps(text, "decide")).toEqual([
      "Arguments for and against",
      "What would change the recommendation",
    ]);
    expect(summaryGaps(WHOLE_DECISION, "decide")).toEqual([]);
    expect(sectionGaps("## Final result\n<the actual answer>", ["Final result"])).toEqual(["Final result"]);
  });

  it("puts filled-in sections in place, and missing ones at the end", () => {
    const text = "### Recommendation\nGo.\n### Arguments for and against\n\n### Where they disagreed\nRent.";
    const headings = ["Recommendation", "Arguments for and against", "Where they disagreed", "Sources cited"];
    const merged = mergeSections(
      text,
      // A section that wasn't asked for doesn't replace the one already there.
      "### Arguments for and against\n- For: demand.\n#### For\nMore.\n### Where they disagreed\nNothing.\n### Sources cited\nNone",
      ["Arguments for and against", "Sources cited"],
      headings,
    );
    expect(merged).toBe(
      "### Recommendation\nGo.\n### Arguments for and against\n- For: demand.\n#### For\nMore.\n\n### Where they disagreed\nRent.\n\n### Sources cited\nNone",
    );
    expect(mergeSections("## Scores\n| a |", "## Final result\nThe plan.", ["Final result"], [], "##")).toBe(
      "## Scores\n| a |\n\n## Final result\nThe plan.",
    );
    expect(lastSection(merged, ["Recommendation", "Where they disagreed"])).toBe("Where they disagreed");
  });

  it("fits texts to a budget by cutting the long ones evenly, keeping every start", () => {
    const fitted = fitTexts(["short", "a".repeat(5000), "b".repeat(5000)], 3000);
    expect(fitted[0]).toBe("short");
    expect(fitted[1]!.startsWith("aaa")).toBe(true);
    expect(fitted[2]!.startsWith("bbb")).toBe(true);
    expect(fitted.join("").length).toBeLessThan(3100);
    expect(fitTexts(["a", "b"], 10)).toEqual(["a", "b"]);
  });

  it("reads a real judge's report whose final result has headings of its own (Qwen 3.5 9B)", () => {
    const report = [
      "## Criteria",
      "- **Scientific realism**: Does it follow research-backed guidance?  ",
      "## Scores",
      "| Racer | Scientific realism | Total |",
      "|-------|--------------------|-------|",
      "| Asha  | 8                  | 30    |",
      "| Bilal | 10                 | 40    |",
      "| Chen  | 9                  | 36    |",
      "",
      "Winner: **Bilal**  ",
      "",
      "## Why  ",
      "Bilal's plan is the only one that fully integrates verified benchmarks.  ",
      "",
      "## Final result",
      "### Adult Touch Typing: A Realistic 30-Day Plan",
      "",
      "**Rule #1:** Accuracy before speed  ",
      "## Tools (All free, no sign-in required unless stated)",
      "| Tool | Why use it today | Link |",
    ].join("\n");
    expect(judgeGaps(report, ["Asha", "Bilal", "Chen"])).toEqual([]);
    // A score table without a racer who handed something in isn't complete.
    expect(
      judgeGaps(report.replace("| Chen  | 9                  | 36    |\n", ""), ["Asha", "Bilal", "Chen"]),
    ).toEqual(["Scores"]);
    expect(judgeGaps(report.replace("## Final result", "## Final Result: the plan"))).toEqual([]);
    // A bold label with the text after it on the same line is the section, with its text.
    expect(sectionGaps("**Why:** Bilal was clearest.\n**Winner:**", ["Why", "Winner"])).toEqual(["Winner"]);
    // "Why this matters" is not the Why section.
    expect(sectionGaps("## Why this matters\nIt does.", ["Why"])).toEqual(["Why"]);
  });

  it("checks a judge's report and reads the top score", () => {
    const racers = [{ name: "Wren" }, { name: "Kestrel" }] as Bot[];
    const report =
      "## Criteria\n- Clarity: easy to follow\n## Scores\n| Racer | Clarity | Total |\n|---|---|---|\n| **Wren** | 6 | 12 |\n| Kestrel | 9 | 17 |\n## Why\nKestrel was clearer.\n## Final result\nThe plan.";
    expect(judgeGaps(report)).toEqual(["Winner"]);
    expect(judgeGaps(`${report}\nWinner: Kestrel`)).toEqual([]);
    expect(judgeGaps("## Criteria\n<criterion>: …")).toContain("template text left in");
    expect(topScorer(report, racers)?.name).toBe("Kestrel");
    expect(topScorer(report.replace("| 12 |", "| 17 |"), racers)).toBeNull();
  });
});

async function group(harness: TestHarness): Promise<Thread> {
  harness.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  const make = async (name: string) =>
    (await harness.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name } })).json()
      .bot as Bot;
  const ada = await make("Ada");
  const bea = await make("Bea");
  const res = await harness.app.inject({
    method: "POST",
    url: "/api/threads",
    headers: auth,
    payload: { memberIds: [ada.id, bea.id] },
  });
  return res.json().thread as Thread;
}

const discussionEnded = (harness: TestHarness) =>
  nextEvent<Discussion>(
    harness.bus,
    (e) =>
      e.type === "discussion.updated" &&
      ["done", "stopped", "error"].includes(e.discussion.status) &&
      e.discussion,
    10_000,
  );

const discuss = (harness: TestHarness, thread: Thread, rounds = 1) =>
  harness.app.inject({
    method: "POST",
    url: `/api/threads/${thread.id}/discussion`,
    headers: auth,
    payload: { topic: "Should we open a second shop?", goal: "decide", rounds },
  });

describe("end-of-discussion reports", () => {
  it("asks once more for the sections a summary left out, and puts them in", async () => {
    const asked: string[] = [];
    const thinking: unknown[] = [];
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You set up discussions")) return reply("Ada: optimist\nBea: skeptic");
        if (system.startsWith("You are the neutral moderator")) {
          const user: string = body.messages[1]?.content ?? "";
          asked.push(user);
          thinking.push(body.think);
          if (user.includes("The summary so far"))
            return reply(
              "### Sources cited\nNone\n### What would change the recommendation\nA rent rise of 20%.",
            );
          return reply(WHOLE_DECISION.split("\n### Sources cited")[0]!);
        }
        const bot = /^You are (\w+)/.exec(system)?.[1];
        return reply(`${bot}'s point (reasoning).`);
      }),
    });
    const thread = await group(h);
    const done = discussionEnded(h);
    expect((await discuss(h, thread)).statusCode).toBe(201);
    const final = await done;

    expect(final).toMatchObject({ status: "done", error: null });
    expect(asked).toHaveLength(2);
    // Thinking is switched off although the model list doesn't say this model thinks (as with Ornith 1.5).
    expect(thinking).toEqual([false, false]);
    expect(asked[1]).toContain(
      "missing, empty or cut off: Sources cited, What would change the recommendation",
    );
    const summary = messageText(h.store.messages.get(final.summaryId!)!);
    expect(summaryGaps(summary, "decide")).toEqual([]);
    expect(summary).toContain("A rent rise of 20%.");
  });

  it("rewrites the section a summary was cut off in", async () => {
    let calls = 0;
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You set up discussions")) return reply("Ada: optimist\nBea: skeptic");
        if (system.startsWith("You are the neutral moderator")) {
          calls += 1;
          if (calls === 1) return reply(`${WHOLE_DECISION.replace("A rent rise.", "A rent ri")}`, "length");
          return reply("### What would change the recommendation\nA rent rise of more than 20%.");
        }
        return reply("A point (reasoning).");
      }),
    });
    const thread = await group(h);
    const done = discussionEnded(h);
    await discuss(h, thread);
    const final = await done;

    const summary = messageText(h.store.messages.get(final.summaryId!)!);
    expect(summary).toContain("A rent rise of more than 20%.");
    expect(summary).not.toContain("A rent ri\n");
    expect(summary.match(/What would change/g)).toHaveLength(1);
  });

  it("still writes the report when the bots' replies start failing after some turns", async () => {
    let turns = 0;
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You set up discussions")) return reply("Ada: optimist\nBea: skeptic");
        if (system.startsWith("You moderate")) return reply("NEXT: Ada");
        if (system.startsWith("You are the neutral moderator")) return reply(WHOLE_DECISION);
        turns += 1;
        if (turns === 1) return reply("Ada opens: demand is there (reasoning).");
        return new Response("model crashed", { status: 500 });
      }),
    });
    const thread = await group(h);
    const done = discussionEnded(h);
    await discuss(h, thread, 3);
    const final = await done;

    expect(final.status).toBe("done");
    expect(final.error).toBeTruthy();
    expect(final.summaryId).not.toBeNull();
    expect(messageText(h.store.messages.get(final.summaryId!)!)).toContain("### Recommendation");
  });

  it("ends without a report when no bot managed to say anything", async () => {
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You set up discussions")) return reply("Ada: optimist\nBea: skeptic");
        if (system.startsWith("You are the neutral moderator")) return reply(WHOLE_DECISION);
        return new Response("model crashed", { status: 500 });
      }),
    });
    const thread = await group(h);
    const done = discussionEnded(h);
    await discuss(h, thread, 3);
    const final = await done;

    expect(final).toMatchObject({ status: "error", summaryId: null });
  });
});

const raceEnded = (harness: TestHarness) =>
  nextEvent<Race>(
    harness.bus,
    (e) => e.type === "race.updated" && ["done", "stopped", "error"].includes(e.race.status) && e.race,
    10_000,
  );

describe("end-of-race reports", () => {
  it("fills in what the judge left out, and finds the winner from the scores", async () => {
    const asked: string[] = [];
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.includes("You are the judge of a race")) {
          const user: string = body.messages.at(-1)?.content ?? "";
          asked.push(user);
          if (user.includes("Your report so far"))
            return reply("## Final result\nOpen at 7am, with a plan for each day (from Kestrel).");
          return reply(
            "## Criteria\n- Clarity: easy to follow\n## Scores\n| Racer | Clarity | Total |\n|---|---|---|\n| Wren | 6 | 6 |\n| Kestrel | 9 | 9 |\n| Robin | 7 | 7 |\n## Why\nKestrel was clearest.",
          );
        }
        const who = /^You are (\w+)/.exec(system)?.[1] ?? "?";
        return reply(`Strategy: be quick.\n${who}'s plan: open at 7am.`);
      }),
    });
    h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    const done = raceEnded(h);
    const res = await h.app.inject({
      method: "POST",
      url: "/api/races",
      headers: auth,
      payload: {
        task: "Plan the shop's opening hours",
        racers: [{ name: "Wren" }, { name: "Kestrel" }, { name: "Robin" }],
        judge: {},
      },
    });
    expect(res.statusCode).toBe(201);
    const final = await done;

    expect(final.status).toBe("done");
    // The judge's turn, then one call for what it left out (the final result and the winner line).
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("Final result, Winner");
    expect(asked[1]).toContain("Kestrel's plan: open at 7am.");
    const report = messageText(h.store.messages.get(final.reportId!)!);
    expect(report).toContain("## Final result\nOpen at 7am");
    expect(h.store.bots.get(final.winnerId!)?.name).toBe("Kestrel");
  });
});
