import { describe, expect, it } from "vitest";

import type { Message } from "@mrog/shared";

import {
  coalesceDeltas,
  HeldEvents,
  keepStreamed,
  mergeDelta,
  mergeMessage,
  replayHeld,
  type Delta,
} from "./messages";

const message = (over: Partial<Message>): Message => ({
  id: "msg_1",
  threadId: "thr_1",
  role: "bot",
  botId: "bot_a",
  moderator: false,
  parallel: false,
  parallelTools: false,
  parts: [],
  status: "done",
  model: null,
  usage: null,
  replyToId: null,
  reactions: [],
  createdAt: "2026-11-03T10:00:00.000Z",
  ...over,
});

const user = message({ id: "msg_0", role: "user", botId: null, parts: [{ type: "text", text: "Hi" }] });

describe("refetched messages", () => {
  it("keeps a streaming reply whose cached text is ahead of the saved copy", () => {
    const cached = [
      user,
      message({ status: "streaming", parts: [{ type: "text", text: "Hello there, frie" }] }),
    ];
    const fetched = [user, message({ status: "streaming", parts: [{ type: "text", text: "Hello" }] })];
    expect(keepStreamed(cached, fetched)).toEqual(cached);
  });

  it("takes the fetched copy once it has caught up or the reply ended", () => {
    const cached = [user, message({ status: "streaming", parts: [{ type: "text", text: "Hello there" }] })];
    const longer = [user, message({ status: "streaming", parts: [{ type: "text", text: "Hello there!" }] })];
    const done = [user, message({ status: "done", parts: [{ type: "text", text: "Hi" }] })];
    expect(keepStreamed(cached, longer)).toBe(longer);
    expect(keepStreamed(cached, done)).toBe(done);
  });

  it("keeps a reply that started after the fetch was answered, but not after Clear chat", () => {
    const started = message({
      id: "msg_2",
      status: "streaming",
      createdAt: "2026-11-03T10:00:05.000Z",
      parts: [{ type: "text", text: "On it" }],
    });
    expect(keepStreamed([user, started], [user])).toEqual([user, started]);
    expect(keepStreamed([user, started], [])).toEqual([]);
  });

  it("keeps a cached reply that gained a card while the saved copy has the same text", () => {
    const card = {
      type: "question" as const,
      questionId: "q1",
      question: "Which one?",
    };
    const cached = [user, message({ status: "streaming", parts: [{ type: "text", text: "Hello" }, card] })];
    const fetched = [user, message({ status: "streaming", parts: [{ type: "text", text: "Hello" }] })];
    expect(keepStreamed(cached, fetched)).toEqual(cached);
  });

  it("keeps a cached reply that has ended when the saved copy still says streaming", () => {
    const cached = [user, message({ status: "done", parts: [{ type: "text", text: "Hello there" }] })];
    const fetched = [user, message({ status: "streaming", parts: [{ type: "text", text: "Hello" }] })];
    expect(keepStreamed(cached, fetched)).toEqual(cached);
    const failed = [user, message({ status: "error", parts: [{ type: "text", text: "Hel" }] })];
    expect(keepStreamed(failed, fetched)).toEqual(failed);
  });

  it("returns the fetched page itself when nothing is streaming", () => {
    const fetched = [user];
    expect(keepStreamed([user, message({})], fetched)).toBe(fetched);
    expect(keepStreamed(undefined, fetched)).toBe(fetched);
  });
});

describe("streamed chunks", () => {
  it("joins back-to-back chunks for the same part, in order", () => {
    const delta = (
      messageId: string,
      partIndex: number,
      text: string,
      kind: "text" | "reasoning" = "text",
    ) => ({
      threadId: "thr_1",
      messageId,
      partIndex,
      kind,
      text,
    });
    expect(
      coalesceDeltas([
        delta("a", 0, "Hel"),
        delta("a", 0, "lo"),
        delta("b", 0, "Hi"),
        delta("a", 0, "!"),
        delta("a", 1, "x", "reasoning"),
      ]),
    ).toEqual([
      delta("a", 0, "Hello"),
      delta("b", 0, "Hi"),
      delta("a", 0, "!"),
      delta("a", 1, "x", "reasoning"),
    ]);
  });
});

describe("streamed chunks on cached messages", () => {
  const chunk = (partIndex: number, text: string, kind: Delta["kind"] = "text"): Delta => ({
    threadId: "thr_1",
    messageId: "msg_1",
    partIndex,
    kind,
    text,
  });
  const streaming = (parts: Message["parts"]) => [user, message({ status: "streaming", parts })];

  it("appends to the part, or starts the next one", () => {
    const old = streaming([{ type: "text", text: "Hel" }]);
    expect(mergeDelta(old, chunk(0, "lo"))).toEqual({
      messages: streaming([{ type: "text", text: "Hello" }]),
      behind: false,
    });
    expect(mergeDelta(old, chunk(1, "why", "reasoning")).messages[1]!.parts).toEqual([
      { type: "text", text: "Hel" },
      { type: "reasoning", text: "why" },
    ]);
  });

  it("leaves a chunk past the end of the parts out, and says the copy is behind", () => {
    const old = streaming([{ type: "text", text: "Hel" }]);
    const result = mergeDelta(old, chunk(2, "oops", "reasoning"));
    expect(result.behind).toBe(true);
    expect(result.messages).toBe(old);
    expect(result.messages[1]!.parts).toHaveLength(1);
  });

  it("ignores a chunk for a message that isn't loaded", () => {
    const old = [user];
    expect(mergeDelta(old, chunk(0, "x"))).toEqual({ messages: old, behind: false });
  });

  it("places a message by id and time", () => {
    const later = message({ id: "msg_9", createdAt: "2026-11-03T10:00:09.000Z" });
    expect(mergeMessage([user], later).map((m) => m.id)).toEqual(["msg_0", "msg_9"]);
    const edited = message({ id: "msg_9", createdAt: later.createdAt, status: "error" });
    expect(mergeMessage([user, later], edited)[1]).toBe(edited);
    const older = message({ id: "msg_old", createdAt: "2026-11-01T10:00:00.000Z" });
    const live = [user, later];
    expect(mergeMessage(live, older)).toBe(live);
  });
});

describe("events that arrive while a thread is first fetched", () => {
  const chunk = (text: string): Delta => ({
    threadId: "thr_1",
    messageId: "msg_1",
    partIndex: 0,
    kind: "text",
    text,
  });

  it("replays them, in order, on top of the page that lands", () => {
    const held = new HeldEvents();
    held.begin("thr_1");
    expect(held.hold("thr_1", { delta: chunk(" there") })).toBe(true);
    expect(held.hold("thr_1", { delta: chunk("!") })).toBe(true);
    const page = [user, message({ status: "streaming", parts: [{ type: "text", text: "Hello" }] })];
    const replayed = replayHeld(page, held.end("thr_1"));
    expect(replayed[1]!.parts).toEqual([{ type: "text", text: "Hello there!" }]);
  });

  it("applies a held message update before the chunks that follow it", () => {
    const held = new HeldEvents();
    held.begin("thr_1");
    const started = message({ status: "streaming", parts: [{ type: "text", text: "A" }] });
    held.hold("thr_1", { message: started });
    held.hold("thr_1", { delta: chunk("B") });
    expect(replayHeld([user], held.end("thr_1"))[1]!.parts).toEqual([{ type: "text", text: "AB" }]);
  });

  it("does not hold anything for a thread that is not being fetched", () => {
    const held = new HeldEvents();
    expect(held.hold("thr_1", { delta: chunk("x") })).toBe(false);
    held.begin("thr_1");
    held.end("thr_1");
    expect(held.hold("thr_1", { delta: chunk("x") })).toBe(false);
    expect(held.end("thr_1")).toEqual([]);
  });

  it("gives what was held to the last fetch still running", () => {
    const held = new HeldEvents();
    held.begin("thr_1");
    held.begin("thr_1");
    held.hold("thr_1", { delta: chunk("x") });
    expect(held.end("thr_1")).toEqual([]);
    expect(held.end("thr_1")).toEqual([{ delta: chunk("x") }]);
  });
});
