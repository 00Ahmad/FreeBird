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
    let seen = "";
    const { make, requests } = await start({
      // The planning question has no "You are …" line, so the fake routes it as "?".
      "?": [
        (body) => {
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
