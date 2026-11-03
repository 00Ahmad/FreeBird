import { getEventListeners } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, messageText, type Bot, type Discussion, type Thread } from "@mrog/shared";

import {
  DISCUSSION_TOOLS,
  keepKnownLinks,
  normalizeUrl,
  parseNext,
  parseRoles,
  URL_PATTERN,
} from "./discussion";
import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

interface Spoken {
  bot: string;
  system: string;
  tools: string[];
}

const reply = (text: string) => ndjson([{ message: { content: text } }, { done: true }]);

async function group(harness: TestHarness): Promise<{ thread: Thread; ada: Bot; bea: Bot }> {
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
  return { thread: res.json().thread as Thread, ada, bea };
}

const ended = (harness: TestHarness, timeoutMs = 10_000) =>
  nextEvent<Discussion>(
    harness.bus,
    (e) =>
      e.type === "discussion.updated" &&
      ["done", "stopped", "error"].includes(e.discussion.status) &&
      e.discussion,
    timeoutMs,
  );

describe("group discussions", () => {
  it("runs rounds with roles, a moderator picking speakers, research-only tools and a summary", async () => {
    const spoken: Spoken[] = [];
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You set up discussions"))
          return reply("- **Ada**: optimist who argues for it\n- Bea — skeptic who checks the evidence");
        if (system.startsWith("You moderate")) return reply("NEXT: Bea\nFOCUS: answer Ada's cost claim");
        if (system.startsWith("You are the neutral moderator"))
          return reply("## Discussion summary\n### Recommendation\nGo, medium confidence.");
        const bot = /^You are (\w+)/.exec(system)?.[1];
        if (bot && system.includes("structured discussion")) {
          spoken.push({
            bot,
            system,
            tools: (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
          });
          return reply(`${bot}'s point (reasoning).`);
        }
        return reply("ok");
      }),
    });
    const { thread } = await group(h);
    const done = ended(h);
    const res = await h.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/discussion`,
      headers: auth,
      payload: { topic: "Should we open a second shop?", goal: "decide", rounds: 2 },
    });
    expect(res.statusCode).toBe(201);
    const final = await done;

    expect(final).toMatchObject({ status: "done", round: 2, speakerId: null, error: null });
    // Round 1 in order; round 2 the moderator picks Bea first, then Ada is the only one left.
    expect(spoken.map((s) => s.bot)).toEqual(["Ada", "Bea", "Bea", "Ada"]);
    expect(spoken[0]!.system).toContain("Your role: optimist who argues for it");
    expect(spoken[1]!.system).toContain("Your role: skeptic who checks the evidence");
    expect(spoken[0]!.system).toContain("Back every claim");
    expect(spoken[0]!.system).toContain("Round 1 of 2");
    expect(spoken[2]!.system).toContain("The moderator asks you to address: answer Ada's cost claim");
    expect(spoken[3]!.system).toContain("the last");
    for (const turn of spoken) for (const tool of turn.tools) expect(DISCUSSION_TOOLS.has(tool)).toBe(true);

    const messages = h.store.messages.list(thread.id);
    expect(messageText(messages[0]!)).toMatch(
      /^Discussion: Should we open a second shop\?\nReach a decision · 2 rounds/,
    );
    const summary = messages.at(-1)!;
    expect(summary).toMatchObject({ role: "bot", botId: null, status: "done", id: final.summaryId });
    expect(messageText(summary)).toContain("### Recommendation");

    const got = await h.app.inject({ url: `/api/threads/${thread.id}/discussion`, headers: auth });
    expect(got.json().discussion).toMatchObject({ status: "done", roles: final.roles });
    // Back to normal afterwards: all tools, normal routing.
    expect(h.services.discussions.isRunning(thread.id)).toBe(false);
  });

  it("hands the user's messages to the next speaker and stops when asked", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spoken: string[] = [];
    h = await makeHarness({
      handlers: fakeOllama(async (body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You set up discussions")) return reply("Ada: builder\nBea: critic");
        const bot = /^You are (\w+)/.exec(system)?.[1];
        if (bot && system.includes("structured discussion")) {
          spoken.push(bot);
          if (spoken.length === 1) await gate;
          return reply(`${bot} here.`);
        }
        return reply("ok");
      }),
    });
    const { thread } = await group(h);
    const firstTurn = nextEvent(
      h.bus,
      (e) => e.type === "discussion.updated" && e.discussion.speakerId !== null,
    );
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/discussion`,
      headers: auth,
      payload: { topic: "Tabs or spaces?", goal: "explore", rounds: 3, roles: {} },
    });
    await firstTurn;

    const busy = await h.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/discussion`,
      headers: auth,
      payload: { topic: "Another one", goal: "explore", rounds: 1 },
    });
    expect(busy.statusCode).toBe(409);

    // A message mid-discussion starts no reply of its own; @Bea makes Bea speak next.
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: auth,
      payload: { text: "@Bea what about tabs for accessibility?" },
    });
    const beaTurn = nextEvent(
      h.bus,
      (e) => e.type === "message.updated" && e.message.status === "done" && spoken.length === 2,
    );
    release();
    await beaTurn;
    expect(spoken).toEqual(["Ada", "Bea"]);

    const done = ended(h);
    await h.app.inject({ method: "POST", url: `/api/threads/${thread.id}/discussion/stop`, headers: auth });
    expect((await done).status).toBe("stopped");
    expect(spoken.length).toBeLessThan(6);
  });

  it("pauses before the next turn, steps one turn at a time, and finishes early with a summary", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spoken: string[] = [];
    h = await makeHarness({
      handlers: fakeOllama(async (body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You set up discussions")) return reply("Ada: builder\nBea: critic");
        if (system.startsWith("You are the neutral moderator")) return reply("## Discussion summary\nShort.");
        if (system.startsWith("You moderate")) return reply("NEXT: Ada");
        const bot = /^You are (\w+)/.exec(system)?.[1];
        if (bot && system.includes("structured discussion")) {
          spoken.push(bot);
          if (spoken.length === 1) await gate;
          return reply(`${bot} here.`);
        }
        return reply("ok");
      }),
    });
    const { thread } = await group(h);
    const control = (action: string) =>
      h!.app.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/discussion/control`,
        headers: auth,
        payload: { action },
      });
    const state = () => h!.services.discussions.get(thread.id)!;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

    const firstTurn = nextEvent(
      h.bus,
      (e) => e.type === "discussion.updated" && e.discussion.speakerId !== null,
    );
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/discussion`,
      headers: auth,
      payload: { topic: "Tabs or spaces?", goal: "decide", rounds: 3 },
    });
    await firstTurn;
    expect((await control("pause")).json().discussion).toMatchObject({ paused: true, status: "running" });
    release();
    await settle();
    // Ada's turn finished; nobody else starts while paused.
    expect(spoken).toEqual(["Ada"]);

    const stepped = nextEvent(
      h.bus,
      (e) => e.type === "discussion.updated" && e.discussion.paused && spoken.length === 2,
    );
    await control("step");
    await stepped;
    await settle();
    expect(spoken).toEqual(["Ada", "Bea"]);
    expect(state()).toMatchObject({ paused: true, speakerId: null });

    const done = ended(h);
    await control("finish");
    const final = await done;
    expect(final).toMatchObject({ status: "done", paused: false });
    expect(spoken).toEqual(["Ada", "Bea"]);
    expect(messageText(h.store.messages.get(final.summaryId!)!)).toContain("Discussion summary");
    expect((await control("pause")).statusCode).toBe(409);
  });

  it("lets a Visual Bot look at the web while discussing, without clicking", async () => {
    const offered: string[][] = [];
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You are Iris") && system.includes("structured discussion"))
          offered.push((body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name));
        return reply("ok");
      }),
    });
    h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    const ada = h.store.bots.create({ name: "Ada" });
    const iris = h.store.bots.create({ name: "Iris", visual: true });
    const thread = h.store.threads.createGroup("Look around", [ada.id, iris.id]);
    const done = ended(h);
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/discussion`,
      headers: auth,
      payload: { topic: "Which phone is cheapest?", goal: "research", rounds: 1 },
    });
    expect((await done).status).toBe("done");
    expect(offered[0]).toEqual(
      expect.arrayContaining(["screen_look", "screen_go_to", "screen_scroll", "screen_back", "screen_watch"]),
    );
    expect(offered[0]).not.toContain("screen_click");
  });

  it("doesn't pile up listeners while it stays paused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h = await makeHarness({
      handlers: fakeOllama(async (body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You set up discussions")) return reply("Ada: builder\nBea: critic");
        if (/^You are \w+/.test(system) && system.includes("structured discussion")) await gate;
        return reply("ok");
      }),
    });
    const { thread } = await group(h);
    const control = (action: string) =>
      h!.app.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/discussion/control`,
        headers: auth,
        payload: { action },
      });
    // The signals that get abort listeners while the loop waits.
    const add = vi.spyOn(AbortSignal.prototype, "addEventListener");
    try {
      const firstTurn = nextEvent(
        h.bus,
        (e) => e.type === "discussion.updated" && e.discussion.speakerId !== null,
      );
      await h.app.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/discussion`,
        headers: auth,
        payload: { topic: "Tabs or spaces?", goal: "explore", rounds: 2 },
      });
      await firstTurn;
      await control("pause");
      release();
      await new Promise((resolve) => setTimeout(resolve, 150));
      add.mockClear();
      // Each control wakes the paused loop, which waits again.
      for (let i = 0; i < 15; i++) await control("pause");
      const listening = Math.max(
        0,
        ...[...new Set(add.mock.contexts)].map(
          (signal) => getEventListeners(signal as AbortSignal, "abort").length,
        ),
      );
      expect(listening).toBeLessThanOrEqual(1);
      const done = ended(h);
      await h.app.inject({ method: "POST", url: `/api/threads/${thread.id}/discussion/stop`, headers: auth });
      expect((await done).status).toBe("stopped");
    } finally {
      add.mockRestore();
    }
  });

  it("needs a group chat", async () => {
    h = await makeHarness();
    h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    const bot = (
      await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Solo" } })
    ).json().bot as Bot;
    const res = await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/discussion`,
      headers: auth,
      payload: { topic: "Anything", goal: "research", rounds: 1 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("clusters", () => {
  const team = [
    {
      name: "Mia",
      expertise: "Cloud cost analyst",
      personality: "Counts every dollar; doubts savings claims.",
    },
    { name: "Raj", expertise: "Security engineer", personality: "Thinks in threat models." },
    { name: "Lea", expertise: "DevOps lead", personality: "Has run two migrations and remembers the pain." },
  ];

  it("proposes 3–5 experts for a topic", async () => {
    h = await makeHarness({
      handlers: fakeOllama(() =>
        reply(
          [
            "| Name | Expertise | Personality |",
            "|---|---|---|",
            ...team.map((m) => `| ${m.name} | ${m.expertise} | ${m.personality} |`),
          ].join("\n"),
        ),
      ),
    });
    h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/clusters/propose",
      headers: auth,
      payload: { topic: "Should we leave AWS?", goal: "decide" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toEqual(
      team.map((m, i) => ({ ...m, color: expect.any(String), ...(i < 0 ? {} : {}) })),
    );
  });

  it("makes experts that live only in the cluster, starts the discussion, and deletes them with it", async () => {
    h = await makeHarness({ handlers: fakeOllama(() => reply("ok")) });
    h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    const own = (
      await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ada" } })
    ).json().bot as Bot;

    const res = await h.app.inject({
      method: "POST",
      url: "/api/clusters",
      headers: auth,
      payload: {
        topic: "Should we leave AWS for our own servers?",
        goal: "decide",
        rounds: 1,
        members: team,
      },
    });
    expect(res.statusCode).toBe(201);
    const { thread, discussion } = res.json() as { thread: Thread; discussion: Discussion };
    expect(thread).toMatchObject({
      kind: "group",
      cluster: true,
      title: "Should we leave AWS for our own servers",
    });
    const experts = thread.memberIds.map((id) => h!.store.bots.get(id)!);
    expect(experts.map((bot) => [bot.name, bot.label, bot.clusterId])).toEqual(
      team.map((m) => [m.name, m.expertise, thread.id]),
    );
    expect(experts[0]!.instructions).toContain("Counts every dollar");
    expect(discussion.status).toBe("running");
    expect(discussion.roles[experts[1]!.id]).toBe("Security engineer — Thinks in threat models.");

    const duplicate = await h.app.inject({
      method: "POST",
      url: "/api/clusters",
      headers: auth,
      payload: { topic: "Again", goal: "decide", rounds: 1, members: [team[0], team[0], team[1]] },
    });
    expect(duplicate.statusCode).toBe(400);

    await h.app.inject({ method: "POST", url: `/api/threads/${thread.id}/discussion/stop`, headers: auth });
    await h.app.inject({ method: "DELETE", url: `/api/threads/${thread.id}`, headers: auth });
    expect(h.store.bots.list().map((bot) => bot.id)).toEqual([own.id]);
  });
});

describe("discussion parsing", () => {
  const bots = [
    { id: "bot_a", name: "Ada" },
    { id: "bot_b", name: "Jean-Luc" },
    { id: "bot_c", name: "Ada Lovelace" },
  ] as Bot[];

  it("reads roles in the usual list styles, keeping hyphenated names whole", () => {
    expect(parseRoles("1. **Ada**: the optimist\n- Jean-Luc — the skeptic\nNobody: ignored", bots)).toEqual({
      bot_a: "the optimist",
      bot_b: "the skeptic",
    });
  });

  it("reads the moderator's pick, preferring the longer matching name", () => {
    expect(parseNext("NEXT: Ada Lovelace\nFOCUS: answer the cost point", bots)).toEqual({
      bot: bots[2],
      focus: "answer the cost point",
    });
    expect(parseNext("I think Jean-Luc should go.", bots)).toEqual({ bot: bots[1], focus: null });
    expect(parseNext("NEXT: someone else", bots)).toBeNull();
  });

  it("reads the moderator's pick with Markdown around the labels, by the first whole name", () => {
    expect(parseNext("**NEXT:** Jean-Luc, then Ada\n**FOCUS:** the cost point", bots)).toEqual({
      bot: bots[1],
      focus: "the cost point",
    });
    expect(parseNext("NEXT: Adam", bots)).toBeNull();
  });

  it("keeps real links whose address has parentheses", () => {
    const url = "https://en.wikipedia.org/wiki/Mercury_(planet)";
    const known = new Set([normalizeUrl(url)]);
    const text = `- [Mercury](${url}) is the smallest planet (source: ${url}).`;
    expect(keepKnownLinks(text, known)).toBe(text);
    expect(text.match(URL_PATTERN)).toEqual([url, url]);
  });

  it("keeps links to addresses the bots used and marks made-up ones", () => {
    const known = new Set(["https://sell.amazon.com/pricing", "https://example.org/a?b=1"].map(normalizeUrl));
    const summary = [
      "- [Amazon pricing](https://sell.amazon.com/pricing/) — the waiver.",
      "- [Amazon fee schedule](https://www.amazon.com/gp/help/customer/display.html) — 15%.",
      "- Survey: https://example.org/a?b=1. Also https://made.up/page.",
    ].join("\n");
    expect(keepKnownLinks(summary, known)).toBe(
      [
        "- [Amazon pricing](https://sell.amazon.com/pricing/) — the waiver.",
        "- Amazon fee schedule (no address given) — 15%.",
        "- Survey: https://example.org/a?b=1. Also (no address given)",
      ].join("\n"),
    );
  });
});
