import { describe, expect, it } from "vitest";

import type { Message } from "@mrog/shared";

import { coalesceDeltas, keepStreamed } from "./messages";

const message = (over: Partial<Message>): Message => ({
  id: "msg_1",
  threadId: "thr_1",
  role: "bot",
  botId: "bot_a",
  moderator: false,
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
