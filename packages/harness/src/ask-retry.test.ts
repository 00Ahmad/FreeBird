import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, type Bot, type Message, type MessagePart } from "@mrog/shared";

import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";
import { withoutFailedReplies } from "./turns";

let h: TestHarness | undefined;
let dataDir: string | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

type QuestionPart = Extract<MessagePart, { type: "question" }>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const toolCall = (name: string, args: Record<string, unknown>) => ({
  message: { tool_calls: [{ function: { name, arguments: args } }] },
});

/** Ollama whose replies come from a script; `delay` holds the next reply back. */
function ollama(replies: unknown[][], delays: number[] = []) {
  const requests: any[] = [];
  return {
    requests,
    handlers: fakeOllama((body) => {
      requests.push(body);
      const rows = [...(replies.shift() ?? [{ message: { content: "ok" } }]), { done: true }];
      const wait = delays.shift() ?? 0;
      if (!wait) return ndjson(rows);
      return new Response(
        new ReadableStream({
          async start(controller) {
            await sleep(wait);
            controller.enqueue(
              new TextEncoder().encode(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"),
            );
            controller.close();
          },
        }),
      );
    }),
  };
}

async function setup(replies: unknown[][] = [], delays: number[] = []) {
  dataDir = mkdtempSync(join(tmpdir(), "mrog-askretry-"));
  const model = ollama(replies, delays);
  h = await makeHarness({ config: { dataDir }, handlers: model.handlers });
  h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  const make = async (name: string) =>
    (await h!.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name } })).json()
      .bot as Bot;
  return { bot: await make("Ada"), make, requests: model.requests };
}

const send = (bot: Bot, text: string) =>
  h!.app.inject({
    method: "POST",
    url: `/api/threads/${bot.threadId}/messages`,
    headers: auth,
    payload: { text },
  });

const finished = () =>
  nextEvent<Message>(
    h!.bus,
    (e) => e.type === "message.updated" && e.message.status !== "streaming" && e.message,
    8000,
  );

const questionPart = (message: Message) =>
  message.parts.find((p): p is QuestionPart => p.type === "question");

/** Waits for the question card to appear and returns it. */
const asked = () =>
  nextEvent<QuestionPart>(
    h!.bus,
    (e) => {
      if (e.type !== "message.updated") return undefined;
      const q = questionPart(e.message);
      return q && q.answer === undefined && q;
    },
    5000,
  );

const answer = (questionId: string, body: Record<string, unknown>) =>
  h!.app.inject({ method: "POST", url: `/api/questions/${questionId}`, headers: auth, payload: body });

describe("questions with choices", () => {
  it("shows the choices on the card and passes a tapped one back as the answer", async () => {
    const { bot, requests } = await setup([
      [toolCall("ask_user", { question: "Which colour?", options: ["Red", "Green", "Blue"] })],
      [{ message: { content: "Green it is." } }],
    ]);
    const card = asked();
    const done = finished();
    await send(bot, "pick");
    const question = await card;
    expect(question).toMatchObject({ question: "Which colour?", options: ["Red", "Green", "Blue"] });
    expect(question).not.toHaveProperty("multiple");

    expect((await answer(question.questionId, { answer: "Green" })).statusCode).toBe(204);
    const reply = await done;
    expect(questionPart(reply)).toMatchObject({ answer: "Green" });
    expect(requests[1].messages.at(-1).content).toBe("The user answered: Green");
  });

  it("takes several picks, keeps them one per line, and tells the bot so unambiguously", async () => {
    const { bot, requests } = await setup([
      [
        toolCall("ask_user", {
          question: "Which cities?",
          options: "Paris, France\nBerlin\nRome",
          multiple: true,
        }),
      ],
      [{ message: { content: "Noted." } }],
    ]);
    const card = asked();
    const done = finished();
    await send(bot, "pick cities");
    const question = await card;
    expect(question).toMatchObject({ options: ["Paris, France", "Berlin", "Rome"], multiple: true });

    expect((await answer(question.questionId, { choices: ["Paris, France", "Rome"] })).statusCode).toBe(204);
    const reply = await done;
    expect(questionPart(reply)?.answer).toBe("Paris, France\nRome");
    expect(requests[1].messages.at(-1).content).toBe("The user chose:\n- Paris, France\n- Rome");
  });

  it("always lets the user type something else, whether or not choices were offered", async () => {
    const { bot, requests } = await setup([
      [toolCall("ask_user", { question: "Which colour?", options: ["Red", "Green"] })],
      [{ message: { content: "Teal." } }],
    ]);
    const card = asked();
    const done = finished();
    await send(bot, "pick");
    await answer((await card).questionId, { answer: "Teal, actually" });
    await done;
    expect(requests[1].messages.at(-1).content).toBe("The user answered: Teal, actually");
  });

  it("is a plain question when the model gave fewer than two usable choices", async () => {
    const { bot } = await setup([
      [toolCall("ask_user", { question: "Name?", options: ["Only one"] })],
      [{ message: { content: "Hi." } }],
    ]);
    const card = asked();
    const done = finished();
    await send(bot, "who");
    const question = await card;
    expect(question).not.toHaveProperty("options");
    await answer(question.questionId, { answer: "Sam" });
    await done;
  });

  it("rejects an empty, missing or oversized answer, and one that is no longer waiting", async () => {
    const { bot } = await setup([
      [toolCall("ask_user", { question: "Pick?", options: ["A", "B"], multiple: true })],
      [{ message: { content: "ok" } }],
    ]);
    const card = asked();
    const done = finished();
    await send(bot, "go");
    const { questionId } = await card;
    for (const bad of [
      {},
      { answer: "  " },
      { choices: [] },
      { choices: ["a", "b", "c", "d", "e", "f", "g", "h"] },
      { choices: [""] },
      { choices: "A" },
    ])
      expect((await answer(questionId, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    expect((await answer(questionId, { choices: ["A", "B"] })).statusCode).toBe(204);
    await done;
    expect((await answer(questionId, { choices: ["A"] })).statusCode).toBe(410);
  });

  it("shows a helper's question with its choices in the coordinator's message", async () => {
    await setup();
    const parts: MessagePart[] = [];
    h!.services.turns.partHooks.set("msg_coordinator", { parts, publish: () => {} });
    const scope = {
      threadId: "thr_x",
      messageId: "msg_coordinator",
      botId: "bot_helper",
      groupChat: false,
      signal: new AbortController().signal,
      asBot: "Bea",
    };
    const waiting = h!.services.agent.questions.ask("Which one?", scope, {
      options: ["Yes", "No"],
      multiple: false,
    });
    expect(parts[0]).toMatchObject({
      type: "question",
      question: "Bea asks: Which one?",
      options: ["Yes", "No"],
    });
    const plain = h!.services.agent.questions.ask("Why?", scope, { options: ["Only one"] });
    expect(parts[1]).not.toHaveProperty("options");
    h!.services.agent.questions.respond((parts[0] as QuestionPart).questionId, "Yes");
    h!.services.agent.questions.respond((parts[1] as QuestionPart).questionId, "Because");
    expect(await waiting).toBe("Yes");
    expect(await plain).toBe("Because");
  });

  it("answers a question by itself when what it asked for happens, and a late reply finds it closed", async () => {
    await setup();
    const parts: MessagePart[] = [];
    h!.services.turns.partHooks.set("msg_self", { parts, publish: () => {} });
    const scope = {
      threadId: "thr_x",
      messageId: "msg_self",
      botId: "bot_x",
      groupChat: false,
      signal: new AbortController().signal,
    };
    let happen!: (text: string) => void;
    const until = new Promise<string>((resolve) => (happen = resolve));
    const waiting = h!.services.agent.questions.ask("Solve the check", scope, { until });
    happen("✓ Solved. Carrying on.");
    expect(await waiting).toBe("✓ Solved. Carrying on.");
    expect(parts[0]).toMatchObject({ type: "question", answer: "✓ Solved. Carrying on." });
    expect(h!.services.agent.questions.respond((parts[0] as QuestionPart).questionId, "done")).toBe(false);
  });
});

describe("trying a reply again", () => {
  /** A user message and a bot reply that went wrong, as a chat would hold them. */
  function failedReply(bot: Bot, parts: MessagePart[], status: "error" | "stopped" | "streaming" = "error") {
    h!.store.messages.create({
      threadId: bot.threadId,
      role: "user",
      parts: [{ type: "text", text: "Summarise the report" }],
    });
    return h!.store.messages.create({ threadId: bot.threadId, role: "bot", botId: bot.id, parts, status });
  }
  const retry = (bot: Bot, messageId: string, botId = bot.id) =>
    h!.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/retry`,
      headers: auth,
      payload: { botId, messageId },
    });
  const botMessages = (bot: Bot) =>
    h!.store.messages.list(bot.threadId).filter((m) => m.role === "bot" && m.botId === bot.id);

  it("answers the user's message again, without the failed reply, and without a new user message", async () => {
    const { bot, requests } = await setup([[{ message: { content: "Here is the summary." } }]]);
    const failed = failedReply(bot, [
      { type: "text", text: "The report says that the HALFWRITTEN" },
      { type: "error", code: "stalled", message: "went quiet" },
    ]);
    const done = finished();
    const res = await retry(bot, failed.id);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ started: true });
    expect((await done).parts.at(-1)).toEqual({ type: "text", text: "Here is the summary." });

    // The model saw the user's message last, not the half-finished reply.
    const sent = requests[0].messages;
    expect(JSON.stringify(sent)).not.toContain("HALFWRITTEN");
    expect(sent.at(-1)).toMatchObject({ role: "user", content: "Summarise the report" });
    expect(h!.store.messages.list(bot.threadId).filter((m) => m.role === "user")).toHaveLength(1);
    expect(botMessages(bot)).toHaveLength(2);
  });

  it("leaves out every unfinished reply when a retry is retried, not only the newest one", async () => {
    const { bot, requests } = await setup([[{ message: { content: "Third time lucky." } }]]);
    h!.store.messages.create({
      threadId: bot.threadId,
      role: "user",
      parts: [{ type: "text", text: "Summarise the report" }],
    });
    // The first attempt stalled partway; the retry of it was stopped partway too. Both left text behind.
    h!.store.messages.create({
      threadId: bot.threadId,
      role: "bot",
      botId: bot.id,
      status: "error",
      parts: [
        { type: "text", text: "FIRSTPARTIAL the report begins" },
        { type: "error", code: "stalled", message: "went quiet" },
      ],
    });
    const second = h!.store.messages.create({
      threadId: bot.threadId,
      role: "bot",
      botId: bot.id,
      status: "stopped",
      parts: [{ type: "text", text: "SECONDPARTIAL it says" }],
    });
    const done = finished();
    expect((await retry(bot, second.id)).statusCode).toBe(202);
    await done;

    const sent = requests[0].messages;
    expect(JSON.stringify(sent)).not.toContain("FIRSTPARTIAL");
    expect(JSON.stringify(sent)).not.toContain("SECONDPARTIAL");
    // The model is answering the user, not carrying on the bot's own half-sentences.
    expect(sent.at(-1)).toMatchObject({ role: "user", content: "Summarise the report" });
  });

  it("keeps finished replies, earlier questions and other bots' replies when it leaves the failed ones out", () => {
    const message = (id: string, role: "user" | "bot", botId: string | null, status: Message["status"]) =>
      ({ id, role, botId, status, parts: [] }) as unknown as Message;
    const history = [
      message("old-user", "user", null, "done"),
      message("old-answer", "bot", "bot_a", "done"),
      message("old-failure", "bot", "bot_a", "error"), // before the latest user message: not part of this retry
      message("user", "user", null, "done"),
      message("other-bot", "bot", "bot_b", "done"),
      message("other-bot-failed", "bot", "bot_b", "error"), // someone else's, in a group
      message("first-failure", "bot", "bot_a", "error"),
      message("retried", "bot", "bot_a", "stopped"),
    ];
    expect(withoutFailedReplies(history, "bot_a", "retried").map((m) => m.id)).toEqual([
      "old-user",
      "old-answer",
      "old-failure",
      "user",
      "other-bot",
      "other-bot-failed",
    ]);
    // Not a retry: nothing is dropped.
    expect(withoutFailedReplies(history, "bot_a", undefined)).toBe(history);
  });

  it("starts one new reply however often it is clicked", async () => {
    const { bot } = await setup([[{ message: { content: "Done." } }]], [150]);
    const failed = failedReply(bot, [{ type: "error", code: "stalled", message: "went quiet" }]);
    const done = finished();
    const [a, b, c] = await Promise.all([
      retry(bot, failed.id),
      retry(bot, failed.id),
      retry(bot, failed.id),
    ]);
    expect(a.json()).toEqual({ started: true });
    // The first click's reply now exists, so the failed one is no longer the latest: the others start nothing.
    expect([b.statusCode, c.statusCode]).toEqual([409, 409]);
    expect([b.json().error, c.json().error]).toEqual(["stale", "stale"]);
    await done;
    await sleep(50);
    expect(botMessages(bot)).toHaveLength(2);
  });

  it("restarts a reply that has not got going, once, even when clicked twice", async () => {
    // The first request answers late (a stuck load); the restart's answer is quick.
    const { bot, requests } = await setup(
      [[{ message: { content: "Late." } }], [{ message: { content: "Quick." } }]],
      [400, 0],
    );
    const first = finished();
    await send(bot, "Summarise the report");
    await sleep(60);
    const [stuck] = botMessages(bot);
    expect(stuck?.status).toBe("streaming");
    expect(stuck?.parts).toEqual([]);

    const [one, two] = await Promise.all([retry(bot, stuck!.id), retry(bot, stuck!.id)]);
    expect(one.statusCode, one.body).toBe(202);
    // The second click either joins the restart under way (202) or finds its new reply already there (409 stale),
    // depending only on timing; either way it starts nothing of its own.
    expect([202, 409], two.body).toContain(two.statusCode);
    if (two.statusCode === 409) expect(two.json().error).toBe("stale");
    await first;
    await sleep(700);

    const messages = botMessages(bot);
    // The stuck one was stopped; the two clicks made a single new reply.
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: stuck!.id, status: "stopped" });
    expect(messages[1]).toMatchObject({ status: "done" });
    expect(messages[1]!.parts.at(-1)).toEqual({ type: "text", text: "Quick." });
    expect(requests).toHaveLength(2);
  });

  it("refuses to repeat something that may already have happened", async () => {
    const { bot } = await setup();
    const sent = failedReply(bot, [
      { type: "tool", callId: "c1", name: "gmail__send", args: {}, status: "error", outward: true },
      { type: "error", code: "stalled", message: "went quiet" },
    ]);
    const res = await retry(bot, sent.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("may_repeat");

    const cut = failedReply(bot, [{ type: "error", code: "interrupted", message: "The app closed" }]);
    expect((await retry(bot, cut.id)).json().error).toBe("may_repeat");
    await sleep(20);
    expect(botMessages(bot)).toHaveLength(2); // nothing new started
  });

  it("refuses a reply that finished, one that isn't the latest, and one that isn't this bot's in this chat", async () => {
    const { bot, make } = await setup();
    const other = await make("Bea");
    const old = failedReply(bot, [{ type: "error", code: "stalled", message: "x" }]);
    const newer = h!.store.messages.create({
      threadId: bot.threadId,
      role: "bot",
      botId: bot.id,
      parts: [{ type: "text", text: "A later answer" }],
      status: "done",
    });

    expect((await retry(bot, old.id)).json().error).toBe("stale");
    expect((await retry(bot, newer.id)).json().error).toBe("not_retryable");
    // Not a member of this chat.
    expect((await retry(bot, newer.id, other.id)).statusCode).toBe(400);
    // A message from another chat.
    const elsewhere = failedReply(other, [{ type: "error", code: "stalled", message: "x" }]);
    expect((await retry(bot, elsewhere.id)).statusCode).toBe(404);
    // Someone else's reply in a chat they share is not retried as this bot's.
    expect((await retry(bot, `msg_${"0".repeat(32)}`)).statusCode).toBe(404);
    // Malformed.
    const bad = await h!.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/retry`,
      headers: auth,
      payload: { botId: "nope" },
    });
    expect(bad.statusCode).toBe(400);
    expect(
      (
        await h!.app.inject({
          method: "POST",
          url: `/api/threads/thr_${"0".repeat(32)}/retry`,
          headers: auth,
          payload: { botId: bot.id, messageId: old.id },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("does not run approvals the old reply was waiting on", async () => {
    // A reply stopped at an approval card is not outward (it never started), so it can be tried again.
    const { bot } = await setup([[{ message: { content: "Fine." } }]]);
    const parts: MessagePart[] = [
      {
        type: "tool",
        callId: "c1",
        name: "run_command",
        args: {},
        status: "error",
        result: "Stopped before anyone answered.",
      },
    ];
    const stopped = failedReply(bot, parts, "stopped");
    const done = finished();
    expect((await retry(bot, stopped.id)).statusCode).toBe(202);
    expect((await done).status).toBe("done");
  });
});
