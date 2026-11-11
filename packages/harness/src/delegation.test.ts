import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DEFAULT_RUNTIME_SETTINGS,
  messageText,
  type Bot,
  type Message,
  type MessagePart,
} from "@mrog/shared";
import { defineTool, safe, type ToolContext, type ToolSpec } from "@mrog/tools";

import { parsePlan } from "./delegation";
import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type Reply = (body: any) => unknown[] | Promise<unknown[]> | Response | Promise<Response>;

/** Routes each chat request by the bot named in its system prompt ("You are X…") to that bot's scripted replies. */
function team(scripts: Record<string, Reply[]>) {
  const requests: { bot: string; body: any }[] = [];
  const handlers = fakeOllama(async (body) => {
    const bot = /You are ([^,:]+)/.exec(body.messages[0]?.content ?? "")?.[1]?.trim() ?? "?";
    requests.push({ bot, body });
    const next = scripts[bot]?.shift();
    const out = next ? await next(body) : [{ message: { content: `${bot} done` } }];
    return out instanceof Response ? out : ndjson([...out, { done: true }]);
  });
  return {
    handlers,
    requests,
    toolsOf: (bot: string) =>
      requests.filter((r) => r.bot === bot).map((r) => (r.body.tools ?? []).map((t: any) => t.function.name)),
  };
}

const call = (name: string, args: Record<string, unknown>) => [
  { message: { tool_calls: [{ function: { name, arguments: args } }] } },
];
const say = (text: string) => [{ message: { content: text } }];

async function start(scripts: Record<string, Reply[]>) {
  const t = team(scripts);
  h = await makeHarness({ handlers: t.handlers });
  h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  const make = async (name: string, extra: Record<string, unknown> = {}) =>
    (
      await h!.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name, ...extra } })
    ).json().bot as Bot;
  return { ...t, make };
}

const send = (bot: Bot, text: string) =>
  h!.app.inject({
    method: "POST",
    url: `/api/threads/${bot.threadId}/messages`,
    headers: auth,
    payload: { text },
  });

const finalOf = (bot: Bot, timeoutMs = 8000) =>
  nextEvent<Message>(
    h!.bus,
    (e) =>
      e.type === "message.updated" &&
      e.message.botId === bot.id &&
      e.message.threadId === bot.threadId &&
      e.message.status !== "streaming" &&
      e.message,
    timeoutMs,
  );

const toolParts = (message: Message) =>
  message.parts.filter((p): p is Extract<MessagePart, { type: "tool" }> => p.type === "tool");

/** Resolves with the approval id of the first card that appears in `bot`'s own chat. */
const cardIn = (bot: Bot, name?: string) =>
  nextEvent<{ id: string; part: Extract<MessagePart, { type: "tool" }> }>(h!.bus, (e) => {
    if (e.type !== "message.updated" || e.message.threadId !== bot.threadId) return undefined;
    const part = toolParts(e.message).find(
      (p) => p.status === "pending_approval" && p.approval && (!name || p.name.includes(name)),
    );
    return part?.approval ? { id: part.approval.id, part } : undefined;
  });

const approve = (id: string) =>
  h!.app.inject({
    method: "POST",
    url: `/api/approvals/${id}`,
    headers: auth,
    payload: { decision: "allow_once" },
  });

describe("coordinators and helpers", () => {
  it("lets only coordinators create helpers, without asking on the model already in use", async () => {
    const { make, toolsOf } = await start({
      Boss: [
        () => call("spawn_bot", { name: "Researcher", instructions: "Find facts." }),
        () => say("Helper ready."),
      ],
    });
    const boss = await make("Boss", { isPrimary: true });
    const member = await make("Member");
    const done = finalOf(boss);
    await send(boss, "compare three laptops");
    const reply = await done;
    expect(toolParts(reply).find((p) => p.name === "spawn_bot")).toMatchObject({ status: "done" });

    const helper = h!.store.bots.list().find((b) => b.name === "Researcher")!;
    expect(helper).toMatchObject({
      parentId: boss.id,
      temporary: true,
      section: "Helpers",
      label: "Helper of Boss",
      coordinator: false,
    });
    expect(toolsOf("Boss")[0]).toEqual(
      expect.arrayContaining(["spawn_bot", "delegate", "dismiss_bot", "message_bot"]),
    );

    await send(member, "hi");
    await finalOf(member);
    expect(toolsOf("Member")[0]).toContain("message_bot");
    expect(toolsOf("Member")[0]).not.toContain("spawn_bot");
  });

  it("tells coordinators to use helpers on their own, and asks before a helper on another model", async () => {
    let system = "";
    const { make } = await start({
      Boss: [
        (body) => {
          system = body.messages[0].content;
          return call("spawn_bot", { name: "Big", instructions: "Think hard.", model: "openai:gpt-big" });
        },
        () => say("ok"),
      ],
    });
    const boss = await make("Boss", { isPrimary: true });
    const card = cardIn(boss, "spawn_bot");
    const done = finalOf(boss);
    await send(boss, "research this");
    expect((await card).part.approval).toMatchObject({
      summary: expect.stringContaining("Create helper “Big”: Think hard. (on openai:gpt-big)"),
    });
    await approve((await card).id);
    await done;
    expect(system).toContain(
      "decide for yourself whether the job needs helpers; the user doesn't have to ask.",
    );
  });

  it("plans a job that splits into parts, so the coordinator hands them to helpers unasked", async () => {
    const asked: string[] = [];
    let plannerThink: unknown = "not sent";
    let seen = "";
    const { make, requests } = await start({
      // The planning question has no "You are …" line, so the fake routes it as "?".
      "?": [
        (body) => {
          plannerThink = body.think;
          asked.push(body.messages.at(-1).content);
          return say(
            "- Find Flask's latest version\n- Find FastAPI's latest version\n- Find Django's latest version",
          );
        },
      ],
      Boss: [
        (body) => {
          seen = body.messages.at(-1).content;
          return say("ok");
        },
        () => say("hi"),
        () => say("sure"),
      ],
    });
    const boss = await make("Boss", { isPrimary: true });
    let done = finalOf(boss);
    await send(boss, "Compare Flask, FastAPI and Django: latest version and async support for each.");
    await done;
    expect(asked).toEqual(["Compare Flask, FastAPI and Django: latest version and async support for each."]);
    // An Ollama model may think without its model list saying so; the planner never spends its room on that.
    expect(plannerThink).toBe(false);
    expect(seen).toContain(
      "(Plan from the app: this job has 3 independent parts:\n1. Find Flask's latest version",
    );
    expect(seen).toContain("Create one helper per part with spawn_bot");

    // Quick messages, and requests that already ask for helpers, aren't planned.
    done = finalOf(boss);
    await send(boss, "thanks!");
    await done;
    done = finalOf(boss);
    await send(boss, "Use two helpers to list fruits and vegetables for me, please.");
    await done;
    expect(requests.filter((r) => r.bot === "?")).toHaveLength(1);
  });

  it("doesn't count the wait for the shared model against the time the plan may take", async () => {
    let seen = "";
    const { make } = await start({
      "?": [() => say("- Find Flask's latest version\n- Find FastAPI's latest version")],
      Boss: [
        (body) => {
          seen = body.messages.at(-1).content;
          return say("ok");
        },
      ],
    });
    h!.services.turns.beforeTurnTimeoutMs = 150;
    const boss = await make("Boss", { isPrimary: true });
    // Another bot has the model for longer than the plan is allowed to take.
    const held = await h!.services.runtime.acquire("user");
    const done = finalOf(boss);
    await send(boss, "Compare Flask and FastAPI: latest version and async support for each.");
    await new Promise((resolve) => setTimeout(resolve, 500));
    held();
    await done;
    expect(seen).toContain("(Plan from the app: this job has 2 independent parts:");
  });

  it("reads a plan's parts and nothing from a reply that keeps the job whole", () => {
    expect(parsePlan("<think>hmm</think>\n1. Look up A\n2) Look up B\n* Look up C")).toEqual([
      "Look up A",
      "Look up B",
      "Look up C",
    ]);
    expect(parsePlan("ONE")).toEqual([]);
    expect(parsePlan(Array.from({ length: 8 }, (_, i) => `- part ${i}`).join("\n"))).toHaveLength(5);
  });

  it("reminds a coordinator doing several lookups itself that helpers could take the parts", async () => {
    const { make } = await start({});
    const boss = await make("Boss", { isPrimary: true });
    const thread = h!.store.threads.get(boss.threadId)!;
    const stub = (name: string) =>
      defineTool({
        name,
        description: name,
        args: z.object({}),
        risk: () => safe(name),
        run: async () => "found",
      });
    const narrow = (names: string[]) =>
      h!.services.agent.toolFilters.reduce((list, filter) => filter(boss, thread, list), names.map(stub));
    const ctx = {} as ToolContext;
    const run = (tools: ToolSpec[], name: string) => tools.find((tool) => tool.name === name)!.run({}, ctx);
    const reminded = (out: unknown) => String(out).includes("create a helper for each remaining part");

    const tools = narrow(["spawn_bot", "delegate", "web_search", "browser_open"]);
    const results = [
      await run(tools, "web_search"),
      await run(tools, "browser_open"),
      await run(tools, "web_search"),
      await run(tools, "web_search"),
    ];
    expect(results.map(reminded)).toEqual([false, false, true, false]);

    // Not once it has handed work out, and not for a bot that can't create helpers.
    const handing = narrow(["spawn_bot", "delegate", "web_search"]);
    await run(handing, "delegate");
    for (let i = 0; i < 3; i++) expect(reminded(await run(handing, "web_search"))).toBe(false);
    const solo = narrow(["web_search"]);
    for (let i = 0; i < 3; i++) expect(reminded(await run(solo, "web_search"))).toBe(false);
  });

  it("runs delegated tasks in parallel and returns every answer", async () => {
    let arrived = 0;
    let release!: () => void;
    const bothIn = new Promise<void>((resolve) => (release = resolve));
    const slow = (text: string) => async () => {
      arrived += 1;
      if (arrived === 2) release();
      await bothIn; // only finishes once both helpers are working at the same time
      return say(text);
    };
    const { make, requests, toolsOf } = await start({
      Boss: [
        () =>
          call("delegate", {
            tasks: [
              { bot_name: "Fruit", task: "Name a fruit" },
              { bot_name: "Veg", task: "Name a vegetable" },
            ],
          }),
        () => say("Apple and carrot."),
      ],
      Fruit: [slow("Apple")],
      Veg: [slow("Carrot")],
    });
    // Two requests at once on the shared model; with one, the helpers would take turns on it.
    h!.store.settings.set("runtime", {
      ...DEFAULT_RUNTIME_SETTINGS,
      sharedModel: "ollama:test:1b",
      parallel: 2,
    });
    const boss = await make("Boss", { isPrimary: true });
    await make("Fruit");
    await make("Veg");
    const done = finalOf(boss);
    await send(boss, "one fruit, one veg");
    const reply = await done;

    expect(messageText(reply)).toBe("Apple and carrot.");
    const result = toolParts(reply)[0]!.result!;
    expect(result).toContain("## Fruit\nApple");
    expect(result).toContain("## Veg\nCarrot");
    // Helpers on a handed-over task get no hand-off tools: no chains, no loops.
    for (const helper of ["Fruit", "Veg"]) {
      expect(toolsOf(helper)[0]).not.toEqual(expect.arrayContaining(["message_bot"]));
      expect(toolsOf(helper)[0]).not.toContain("delegate");
    }
    expect(requests.find((r) => r.bot === "Fruit")!.body.messages[0].content).toContain(
      "task Boss handed you",
    );
  });

  it("lets helpers take turns on a shared model that runs one request at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const slow = (text: string) => async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight -= 1;
      return say(text);
    };
    const { make } = await start({
      Boss: [
        () =>
          call("delegate", {
            tasks: [
              { bot_name: "Fruit", task: "Name a fruit" },
              { bot_name: "Veg", task: "Name a vegetable" },
            ],
          }),
        () => say("Done."),
      ],
      Fruit: [slow("Apple")],
      Veg: [slow("Carrot")],
    });
    const boss = await make("Boss", { isPrimary: true });
    await make("Fruit");
    await make("Veg");
    const done = finalOf(boss);
    await send(boss, "one fruit, one veg");
    const result = toolParts(await done)[0]!.result!;
    expect(result).toContain("## Fruit\nApple");
    expect(result).toContain("## Veg\nCarrot");
    expect(most).toBe(1);
    expect(h!.services.runtime.queueState()).toEqual({ running: 0, waiting: 0 });
  });

  it("makes the helpers delegate names, so skipping spawn_bot doesn't leave a coordinator with nobody", async () => {
    let scoutSystem = "";
    const { make } = await start({
      Boss: [
        () =>
          call("delegate", {
            tasks: [
              { bot_name: "Scout", task: "Find the first fact" },
              { bot_name: "archer_two", task: "Find the second fact" },
            ],
          }),
        () => say("Combined."),
      ],
      Scout: [
        (body) => {
          scoutSystem = body.messages[0].content;
          return say("fact one");
        },
      ],
    });
    const boss = await make("Boss", { isPrimary: true });
    const done = finalOf(boss);
    await send(boss, "go");
    const reply = await done;

    // No approval card was needed, and both helpers answered.
    const result = toolParts(reply).find((part) => part.name === "delegate")!;
    expect(result).toMatchObject({ status: "done" });
    expect(result.result).toContain("(Created helpers Scout, archer_two for this.)");
    expect(result.result).toContain("## Scout\nfact one");
    expect(result.result).toContain("## archer_two\narcher_two done");
    const helpers = h!.store.bots.list().filter((bot) => bot.parentId === boss.id);
    expect(helpers.map((bot) => bot.name).toSorted()).toEqual(["Scout", "archer_two"]);
    expect(helpers.every((bot) => bot.temporary)).toBe(true);

    // The helper is told what it's doing; the thread it works in isn't a group chat with a user in it.
    expect(scoutSystem).toContain("You're working on a task Boss handed you");
    expect(scoutSystem).not.toContain("group chat");
  });

  it("takes a name with other spacing or case for the bot it names, and still stops at the helper limit", async () => {
    const { make } = await start({
      Boss: [
        () => call("delegate", { tasks: [{ bot_name: "research_bot", task: "Look it up" }] }),
        () => say("ok"),
        () => call("delegate", { tasks: [{ bot_name: "Seventh", task: "One more" }] }),
        () => say("ok"),
      ],
    });
    const boss = await make("Boss", { isPrimary: true });
    const researcher = await make("Research Bot");

    let done = finalOf(boss);
    await send(boss, "first");
    const first = toolParts(await done)[0]!;
    expect(first.result).toContain("## Research Bot");
    expect(first.result).not.toContain("Created");
    expect(h!.store.bots.list().filter((bot) => bot.parentId === boss.id)).toHaveLength(0);
    expect(researcher.name).toBe("Research Bot");

    for (let i = 1; i <= 6; i++)
      h!.store.bots.create(
        { name: `Helper ${i}` },
        { parentId: boss.id, temporary: true, section: "Helpers" },
      );
    done = finalOf(boss);
    await send(boss, "second");
    expect(toolParts(await done)[0]!.result).toContain("You already have 6 helpers");
    expect(h!.store.bots.list().some((bot) => bot.name === "Seventh")).toBe(false);
  });

  it("gives every helper its own thread with the coordinator, and keeps using it for later tasks", async () => {
    const { make } = await start({
      Boss: [
        () =>
          call("delegate", {
            tasks: [
              { bot_name: "Scout", task: "Find the first fact" },
              { bot_name: "Archer", task: "Find the second fact" },
            ],
          }),
        () => say("Combined."),
        () => call("delegate", { tasks: [{ bot_name: "Scout", task: "Check the first fact" }] }),
        () => say("Checked."),
      ],
      Scout: [() => say("fact one"), () => say("fact one is right")],
      Archer: [() => say("fact two")],
    });
    const boss = await make("Boss", { isPrimary: true });
    let done = finalOf(boss);
    await send(boss, "go");
    await done;

    const talks = () => h!.store.threads.list().filter((thread) => thread.pair);
    const names = new Map(h!.store.bots.list().map((bot) => [bot.id, bot.name]));
    const said = (title: string) =>
      h!.store.messages
        .list(talks().find((thread) => thread.title === title)!.id)
        .map((message) => `${names.get(message.botId!)}: ${messageText(message)}`);

    // One thread per helper, each with just the coordinator and that helper, holding the task and the answer.
    expect(
      talks()
        .map((thread) => thread.title)
        .toSorted(),
    ).toEqual(["Boss ↔ Archer", "Boss ↔ Scout"]);
    for (const talk of talks()) {
      expect(talk.memberIds).toHaveLength(2);
      expect(talk.memberIds).toContain(boss.id);
    }
    expect(said("Boss ↔ Scout")).toEqual(["Boss: Find the first fact", "Scout: fact one"]);
    expect(said("Boss ↔ Archer")).toEqual(["Boss: Find the second fact", "Archer: fact two"]);

    // A later task for the same helper goes on in that thread; it doesn't start another.
    done = finalOf(boss);
    await send(boss, "again");
    await done;
    expect(talks()).toHaveLength(2);
    expect(said("Boss ↔ Scout")).toEqual([
      "Boss: Find the first fact",
      "Scout: fact one",
      "Boss: Check the first fact",
      "Scout: fact one is right",
    ]);
    expect(said("Boss ↔ Archer")).toHaveLength(2);
  });

  it("gives a helper its thread with the coordinator as soon as it is created, before any work", async () => {
    const { make } = await start({
      Boss: [
        () => call("spawn_bot", { name: "Researcher", instructions: "Find facts." }),
        () => say("Made it."),
      ],
    });
    const boss = await make("Boss", { isPrimary: true });
    const done = finalOf(boss);
    await send(boss, "set up a researcher");
    const reply = await done;

    // The reply tells the model what to do next, and the conversation already exists, empty.
    expect(toolParts(reply)[0]!.result).toContain("give it its task with delegate");
    const talks = h!.store.threads.list().filter((thread) => thread.pair);
    expect(talks.map((thread) => thread.title)).toEqual(["Boss ↔ Researcher"]);
    expect(talks[0]!.memberIds).toHaveLength(2);
    expect(h!.store.messages.list(talks[0]!.id)).toEqual([]);
  });

  it("never makes a helper in a group chat, where nobody could answer its approval cards", async () => {
    const { make, toolsOf } = await start({
      Boss: [() => call("delegate", { tasks: [{ bot_name: "Ghost", task: "Do it" }] }), () => say("ok")],
    });
    const boss = await make("Boss", { isPrimary: true });
    const mate = await make("Mate");
    const group = h!.store.threads.createGroup(null, [boss.id, mate.id]);
    const done = nextEvent<Message>(
      h!.bus,
      (e) =>
        e.type === "message.updated" &&
        e.message.botId === boss.id &&
        e.message.threadId === group.id &&
        e.message.status !== "streaming" &&
        e.message,
      8000,
    );
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${group.id}/messages`,
      headers: auth,
      payload: { text: "@Boss please get this done" },
    });
    const reply = await done;
    expect(toolParts(reply)[0]!.result).toBe('No teammate is called "Ghost". Teammates: Mate.');
    expect(h!.store.bots.list().some((bot) => bot.name === "Ghost")).toBe(false);
    expect(toolsOf("Boss")[0]).not.toContain("spawn_bot");
  });

  it("doesn't make a helper for a delegate name when spawn_bot is switched off for the coordinator", async () => {
    const { make, toolsOf } = await start({
      Boss: [() => call("delegate", { tasks: [{ bot_name: "Ghost", task: "Do it" }] }), () => say("ok")],
    });
    const boss = await make("Boss", {
      isPrimary: true,
      tools: { allow: null, exclude: ["spawn_bot"] },
    });
    const mate = await make("Mate");
    const done = finalOf(boss);
    await send(boss, "get this done");
    const reply = await done;
    expect(toolParts(reply)[0]!.result).toBe(`No teammate is called "Ghost". Teammates: ${mate.name}.`);
    expect(h!.store.bots.list().some((bot) => bot.name === "Ghost")).toBe(false);
    expect(toolsOf("Boss")[0]).toContain("delegate");
    expect(toolsOf("Boss")[0]).not.toContain("spawn_bot");
  });

  it("doesn't guess between two bots whose names differ only in spacing or punctuation", async () => {
    const { make } = await start({
      Boss: [() => call("delegate", { tasks: [{ bot_name: "researchbot", task: "Look" }] }), () => say("ok")],
    });
    const boss = await make("Boss", { isPrimary: true });
    await make("Research Bot");
    await make("Research-Bot");
    const done = finalOf(boss);
    await send(boss, "go");
    expect(toolParts(await done)[0]!.result).toContain('More than one teammate is called "researchbot"');
    expect(h!.store.bots.list().filter((bot) => bot.parentId === boss.id)).toHaveLength(0);
  });

  it("refuses unknown, ambiguous or repeated targets with a message the model can use", async () => {
    const { make } = await start({
      Boss: [
        () =>
          call("delegate", {
            tasks: [
              { bot_name: "Fruit", task: "a" },
              { bot_name: "fruit", task: "b" },
            ],
          }),
        () => say("ok"),
      ],
    });
    const boss = await make("Boss", { isPrimary: true });
    await make("Fruit");
    const done = finalOf(boss);
    await send(boss, "go");
    expect(toolParts(await done)[0]!.result).toContain("appears twice");
  });

  it("stops helpers when the coordinator is stopped", async () => {
    const { make } = await start({
      Boss: [() => call("delegate", { tasks: [{ bot_name: "Slow", task: "take forever" }] })],
      Slow: [
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(`${JSON.stringify({ message: { content: "working" } })}\n`),
                );
              },
            }),
          ),
      ],
    });
    const boss = await make("Boss", { isPrimary: true });
    const slow = await make("Slow");
    const helperStarted = nextEvent(h!.bus, (e) => e.type === "message.delta" && e.text === "working");
    const helperDone = nextEvent<Message>(
      h!.bus,
      (e) =>
        e.type === "message.updated" &&
        e.message.botId === slow.id &&
        e.message.status !== "streaming" &&
        e.message,
    );
    const bossDone = finalOf(boss);
    await send(boss, "go");
    await helperStarted;
    await h!.app.inject({ method: "POST", url: `/api/threads/${boss.threadId}/stop`, headers: auth });
    expect((await helperDone).status).toBe("stopped");
    expect((await bossDone).status).toBe("stopped");
  });

  it("shows a helper's approval cards and questions in the coordinator's chat", async () => {
    const { make } = await start({
      Boss: [
        () => call("delegate", { tasks: [{ bot_name: "Runner", task: "check git" }] }),
        () => say("Runner checked."),
      ],
      Runner: [
        () => call("ask_user", { question: "Which repo?" }),
        () => call("run_command", { command: "echo surfaced-ok" }),
        () => say("git is fine"),
      ],
    });
    const boss = await make("Boss", { isPrimary: true });
    await make("Runner");

    const question = nextEvent<{ id: string; text: string }>(h!.bus, (e) => {
      if (e.type !== "message.updated" || e.message.threadId !== boss.threadId) return undefined;
      const q = e.message.parts.find((p: MessagePart) => p.type === "question" && !p.answer);
      return q?.type === "question" ? { id: q.questionId, text: q.question } : undefined;
    });
    const card = cardIn(boss, "Runner · run_command");
    const done = finalOf(boss);
    await send(boss, "have Runner check git");

    const asked = await question;
    expect(asked.text).toBe("Runner asks: Which repo?");
    await h!.app.inject({
      method: "POST",
      url: `/api/questions/${asked.id}`,
      headers: auth,
      payload: { answer: "this one" },
    });
    const approval = await card;
    expect(approval.part.approval).toMatchObject({ kind: "terminal", summary: "echo surfaced-ok" });
    await approve(approval.id);
    const reply = await done;

    expect(messageText(reply)).toBe("Runner checked.");
    expect(toolParts(reply).find((p) => p.name === "delegate")!.result).toContain("git is fine");
    expect(toolParts(reply).find((p) => p.name === "Runner · run_command")).toMatchObject({ status: "done" });
  });

  it("hides helpers after the coordinator's turn, dismisses them, and removes them with their coordinator", async () => {
    const { make } = await start({
      Boss: [
        () => call("spawn_bot", { name: "Temp", instructions: "Temporary." }),
        () => say("made"),
        () => call("dismiss_bot", { bot_name: "Temp" }),
        () => say("gone"),
      ],
    });
    const boss = await make("Boss", { isPrimary: true });
    await h!.app.inject({
      method: "POST",
      url: "/api/permissions/rules",
      headers: auth,
      payload: { tool: "spawn_bot", match: null, decision: "allow" },
    });

    const hidden = nextEvent<Bot>(
      h!.bus,
      (e) => e.type === "bot.updated" && e.bot.name === "Temp" && e.bot.hidden && e.bot,
    );
    let done = finalOf(boss);
    await send(boss, "make a helper");
    await done;
    expect(await hidden).toMatchObject({ hidden: true, temporary: true });

    done = finalOf(boss);
    await send(boss, "dismiss it");
    await done;
    expect(h!.store.bots.list().find((b) => b.name === "Temp")).toBeUndefined();

    const again = h!.store.bots.create(
      { name: "Orphan" },
      { parentId: boss.id, temporary: true, section: "Helpers" },
    );
    await h!.app.inject({ method: "DELETE", url: `/api/bots/${boss.id}`, headers: auth });
    expect(h!.store.bots.get(again.id)).toBeNull();
  });

  it("lets you make another bot a coordinator, but never a helper", async () => {
    const { make, toolsOf } = await start({});
    const lead = await make("Lead", { coordinator: true });
    await send(lead, "hi");
    await finalOf(lead);
    expect(toolsOf("Lead")[0]).toContain("spawn_bot");

    const helper = h!.store.bots.create(
      { name: "Kid" },
      { parentId: lead.id, temporary: true, section: "Helpers" },
    );
    const res = await h!.app.inject({
      method: "PATCH",
      url: `/api/bots/${helper.id}`,
      headers: auth,
      payload: { coordinator: true },
    });
    expect(res.json().bot.coordinator).toBe(false);
  });
});

describe("delegate arguments", () => {
  it("accepts a single task sent flat instead of a tasks list", async () => {
    const { make } = await start({
      Boss: [() => call("delegate", { bot_name: "Fruit", task: "Name a fruit" }), () => say("Got it.")],
      Fruit: [() => say("Mango")],
    });
    const boss = await make("Boss", { isPrimary: true });
    await make("Fruit");
    const done = finalOf(boss);
    await send(boss, "ask fruit");
    expect(toolParts(await done)[0]).toMatchObject({
      name: "delegate",
      status: "done",
      result: "## Fruit\nMango",
    });
  });

  it("passes earlier answers on to the next step with include_results_from", async () => {
    const { make } = await start({
      Boss: [
        () => call("delegate", { tasks: [{ bot_name: "Fruit", task: "Name a fruit" }] }),
        () => call("delegate", { bot_name: "Checker", task: "Check it", include_results_from: "Fruit" }),
        () => say("Checked."),
      ],
      Fruit: [() => say("Mango")],
      Checker: [
        (body) => {
          const task = body.messages.at(-1).content as string;
          return say(task.includes("--- Results from Fruit ---\nMango") ? "Saw Mango" : "Saw nothing");
        },
      ],
    });
    const boss = await make("Boss", { isPrimary: true });
    await make("Fruit");
    await make("Checker");
    const done = finalOf(boss);
    await send(boss, "pipeline");
    const tools = toolParts(await done);
    expect(tools[1]).toMatchObject({ status: "done", result: "## Checker\nSaw Mango" });
  });

  it("says so when a step asks for results that don't exist yet", async () => {
    const { make } = await start({
      Boss: [
        () =>
          call("delegate", {
            tasks: [{ bot_name: "Checker", task: "Check it", include_results_from: ["Fruit"] }],
          }),
        () => say("ok"),
      ],
    });
    const boss = await make("Boss", { isPrimary: true });
    await make("Fruit");
    await make("Checker");
    const done = finalOf(boss);
    await send(boss, "pipeline");
    expect(toolParts(await done)[0]?.result).toContain("Fruit hasn't answered you yet");
  });
});
