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
      handlers: {
        ...fakeOllama((body) => {
          const system: string = body.messages[0]?.content ?? "";
          if (system.startsWith("You are Iris") && system.includes("structured discussion"))
            offered.push(
              (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
            );
          return reply("ok");
        }),
        // A Visual Bot needs a model that can see.
        "/api/tags": () =>
          Response.json({
            models: [
              {
                name: "test:1b",
                size: 1,
                capabilities: ["completion", "tools", "vision"],
                details: { context_length: 8192 },
              },
            ],
          }),
      },
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

describe("a discussion whose team changes", () => {
  const summaryText =
    "## Discussion summary\n### Most promising ideas\n- [Ada's source](https://example.org/ada) held up.\n### Weak spots and risks\nNone.\n### Where they disagreed\nNone.\n### Sources cited\n- https://example.org/ada\n### Open questions\nNone.";

  function panel(harness: TestHarness, names: string[]) {
    harness.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    const bots = names.map((name) => harness.store.bots.create({ name }));
    const thread = harness.store.threads.createGroup(
      "Panel",
      bots.map((bot) => bot.id),
    );
    return { bots, thread };
  }
  const drop = (harness: TestHarness, bot: Bot) =>
    harness.app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: auth });
  const begin = (harness: TestHarness, thread: Thread, rounds: number) =>
    harness.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/discussion`,
      headers: auth,
      payload: { topic: "Should we open a second shop?", goal: "explore", rounds },
    });
  const speakerOf = (system: string) =>
    system.includes("structured discussion") ? /^You are (\w+)/.exec(system)?.[1] : undefined;

  it("carries on when experts are deleted mid-round, and keeps what a deleted expert said", async () => {
    const spoken: string[] = [];
    let summaryPrompt = "";
    let ada!: Bot;
    let dan!: Bot;
    h = await makeHarness({
      handlers: fakeOllama(async (body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You are the neutral moderator")) {
          summaryPrompt = body.messages.at(-1)?.content ?? "";
          return reply(summaryText);
        }
        const bot = speakerOf(system);
        if (!bot) return reply("");
        spoken.push(bot);
        // One who already spoke and one who hasn't leave while Bea is speaking.
        if (bot === "Bea") await Promise.all([drop(h!, ada), drop(h!, dan)]);
        return reply(`${bot} here. https://example.org/${bot.toLowerCase()}`);
      }),
    });
    const { bots, thread } = panel(h, ["Ada", "Bea", "Cy", "Dan"]);
    [ada, , , dan] = bots as [Bot, Bot, Bot, Bot];
    const done = ended(h);
    await begin(h, thread, 1);
    const final = await done;

    expect(final).toMatchObject({ status: "done", error: null });
    expect(spoken).toEqual(["Ada", "Bea", "Cy"]);
    const summary = h.store.messages.get(final.summaryId!)!;
    expect(summary.status).toBe("done");
    // Ada's link survives her deletion, and she shows up as a former expert, not as the moderator.
    expect(messageText(summary)).toContain("[Ada's source](https://example.org/ada)");
    expect(summaryPrompt).toContain("[A former expert]: Ada here.");
    expect(summaryPrompt).not.toContain("[Moderator]: Ada");
    expect(summaryPrompt).toContain("- https://example.org/ada (a former expert)");
  });

  it("carries on when the speaker is deleted mid-turn", async () => {
    const spoken: string[] = [];
    let bea!: Bot;
    h = await makeHarness({
      handlers: fakeOllama(async (body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You are the neutral moderator")) return reply(summaryText);
        const bot = speakerOf(system);
        if (!bot) return reply("");
        spoken.push(bot);
        if (bot === "Bea") {
          await drop(h!, bea);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return reply(`${bot} here.`);
      }),
    });
    const { bots, thread } = panel(h, ["Ada", "Bea", "Cy"]);
    bea = bots[1]!;
    const done = ended(h);
    await begin(h, thread, 1);
    const final = await done;

    expect(final).toMatchObject({ status: "done", error: null });
    expect(spoken).toEqual(["Ada", "Bea", "Cy"]);
    expect(h.store.messages.get(final.summaryId!)).toMatchObject({ status: "done" });
  });

  it("skips experts deleted while the moderator was choosing", async () => {
    const spoken: string[] = [];
    const asked: string[] = [];
    let cy!: Bot;
    let dan!: Bot;
    h = await makeHarness({
      handlers: fakeOllama(async (body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You are the neutral moderator")) return reply(summaryText);
        if (system.startsWith("You moderate")) {
          asked.push(body.messages.at(-1)?.content ?? "");
          if (asked.length > 1) return reply("NEXT: Ada");
          // The one it picks and another are deleted before it answers.
          await Promise.all([drop(h!, cy), drop(h!, dan)]);
          return reply("NEXT: Cy");
        }
        const bot = speakerOf(system);
        if (bot) spoken.push(bot);
        return reply(bot ? `${bot} here.` : "");
      }),
    });
    const { bots, thread } = panel(h, ["Ada", "Bea", "Cy", "Dan"]);
    [, , cy, dan] = bots as [Bot, Bot, Bot, Bot];
    const done = ended(h);
    await begin(h, thread, 2);
    const final = await done;

    expect(final).toMatchObject({ status: "done", error: null });
    expect(spoken).toEqual(["Ada", "Bea", "Cy", "Dan", "Ada", "Bea"]);
    // The moderator's next choice is only among those still there.
    expect(asked[1]).toContain("- Ada");
    expect(asked[1]).not.toMatch(/- (Cy|Dan)/);
    expect(h.store.messages.get(final.summaryId!)).toMatchObject({ status: "done" });
  });

  it("summarizes what was said when too few bots are left to go on", async () => {
    const spoken: string[] = [];
    h = await makeHarness({
      handlers: fakeOllama(async (body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You are the neutral moderator")) return reply(summaryText);
        const bot = speakerOf(system);
        if (!bot) return reply("");
        spoken.push(bot);
        // Bea is taken out of the chat while Ada speaks.
        h!.store.threads.update(thread.id, { memberIds: [ada.id] });
        return reply(`${bot} here.`);
      }),
    });
    const { bots, thread } = panel(h, ["Ada", "Bea"]);
    const ada = bots[0]!;
    const done = ended(h);
    await begin(h, thread, 2);
    const final = await done;

    expect(spoken).toEqual(["Ada"]);
    expect(final).toMatchObject({ status: "done", error: "A discussion needs at least two bots." });
    expect(h.store.messages.get(final.summaryId!)).toMatchObject({ status: "done" });
  });

  it("ends only when replies fail several times in a row", async () => {
    let turn = 0;
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You are the neutral moderator")) return reply(summaryText);
        if (system.startsWith("You moderate")) return reply("NEXT: nobody");
        if (!speakerOf(system)) return reply("");
        turn += 1;
        // Three failures, each with a good turn in between.
        return [2, 4, 6].includes(turn)
          ? new Response("model crashed", { status: 500 })
          : reply("A point (reasoning).");
      }),
    });
    const { thread } = panel(h, ["Ada", "Bea", "Cy"]);
    const done = ended(h, 20_000);
    await begin(h, thread, 3);
    const final = await done;

    expect(final).toMatchObject({ status: "done", round: 3, error: null });
    expect(turn).toBeGreaterThanOrEqual(9);
  });

  it("clears the summary's message and the working mark when preparing it fails", async () => {
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        const system: string = body.messages[0]?.content ?? "";
        return reply(speakerOf(system) ? "A point (reasoning)." : "");
      }),
    });
    const { thread } = panel(h, ["Ada", "Bea"]);
    // Reading the messages fails once the summary starts.
    const unsubscribe = h.bus.subscribe((event) => {
      if (event.type === "discussion.updated" && event.discussion.status === "summarizing") {
        vi.spyOn(h!.store.messages, "list").mockImplementation(() => {
          throw new Error("the database is locked");
        });
      }
    });
    const done = ended(h);
    await begin(h, thread, 1);
    const final = await done;
    unsubscribe();
    vi.restoreAllMocks();

    expect(final).toMatchObject({ status: "error", error: "the database is locked" });
    expect(h.store.messages.get(final.summaryId!)).toMatchObject({ status: "error" });
    expect(h.services.turns.activities()[thread.id]).toBeUndefined();
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

  it("keeps the marks around an address that was made up or real", () => {
    const known = new Set([normalizeUrl("https://a.com/x")]);
    const bad = "https://b.com/y";
    // Real ones stay as they are, whatever closes them.
    for (const text of [
      "`https://a.com/x`",
      "**https://a.com/x**",
      "_https://a.com/x_",
      "“https://a.com/x”",
      "https://a.com/x…",
      "https://a.com/x。",
      "(https://a.com/x)",
      "HTTPS://A.com/x",
    ])
      expect(keepKnownLinks(text, known), text).toBe(text);
    // Made-up ones are replaced, and what closes around them stays balanced.
    expect(keepKnownLinks(`\`${bad}\``, known)).toBe("`(no address given)`");
    expect(keepKnownLinks(`**${bad}**`, known)).toBe("**(no address given)**");
    expect(keepKnownLinks(`“${bad}”`, known)).toBe("“(no address given)”");
    expect(keepKnownLinks(`${bad}…`, known)).toBe("(no address given)");
    expect(keepKnownLinks("See HTTPS://made.up/x", known)).toBe("See (no address given)");
  });

  it("leaves text that looks like a held-back link alone", () => {
    const known = new Set([normalizeUrl("https://a.com/x")]);
    expect(keepKnownLinks("Item ⟦7⟧ and [A](https://a.com/x) and ⟦0⟧", known)).toBe(
      "Item 7 and [A](https://a.com/x) and 0",
    );
  });

  it("counts the links the user gave as known", async () => {
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        const system: string = body.messages[0]?.content ?? "";
        if (system.startsWith("You are the neutral moderator"))
          return reply(
            "## Discussion summary\n### Recommendation\nSee [the guide](https://docs.example.com/guide) and [the brief](https://docs.example.com/brief), not [this](https://made.up/z).\n### Arguments for and against\nNone.\n### Where they disagreed\nNone.\n### Sources cited\nNone.\n### What would change the recommendation\nNothing.",
          );
        if (system.includes("structured discussion")) {
          // The user adds a link while the bots are talking.
          h!.store.messages.create({
            threadId: thread.id,
            role: "user",
            parts: [{ type: "text", text: "Also read https://docs.example.com/brief." }],
          });
        }
        return reply("A point (reasoning).");
      }),
    });
    const { thread } = await group(h);
    const done = ended(h);
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/discussion`,
      headers: auth,
      payload: { topic: "Is https://docs.example.com/guide right?", goal: "decide", rounds: 1 },
    });
    const final = await done;
    expect(messageText(h.store.messages.get(final.summaryId!)!)).toContain(
      "See [the guide](https://docs.example.com/guide) and [the brief](https://docs.example.com/brief), not this (no address given).",
    );
  });
});
