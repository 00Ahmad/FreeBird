import { describe, expect, it } from "vitest";

import {
  ProviderError,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type StreamChunk,
} from "@mrog/providers";
import type { Message, ModelCapability } from "@mrog/shared";

import { FenceFilter, fitHistory, runTurn, toChatHistory, type ToolHost, type TurnSink } from ".";

/** A provider that replays one scripted reply per call and records each request. */
function scripted(replies: StreamChunk[][]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    id: "fake",
    label: "Fake",
    kind: "ollama",
    local: true,
    requests,
    listModels: async () => [],
    async *chat(request) {
      requests.push(structuredClone({ ...request, signal: undefined }));
      for (const chunk of replies.shift() ?? []) yield chunk;
    },
  };
}

const done = (inputTokens = 1, outputTokens = 1): StreamChunk => ({
  type: "done",
  finishReason: "stop",
  usage: { inputTokens, outputTokens },
});

function recorder() {
  const log: string[] = [];
  const sink: TurnSink = {
    text: (t) => log.push(`text:${t}`),
    reasoning: (t) => log.push(`think:${t}`),
    toolStart: (c) => log.push(`start:${c.name}`),
    toolEnd: (_id, o) => log.push(`end:${o.status}:${o.result}`),
  };
  return { log, sink };
}

const echoTools: ToolHost = {
  definitions: () => [{ name: "echo", description: "Echo", parameters: { type: "object" } }],
  execute: async (call) => ({ status: "done", result: `echo:${JSON.stringify(call.arguments)}` }),
};

const base = (provider: ChatProvider, sink: TurnSink, over: object = {}) => ({
  provider,
  model: "m",
  capabilities: ["completion", "tools"] as ModelCapability[],
  system: "You are a bot.",
  history: [{ role: "user", content: "hi" }] as ChatMessage[],
  contextWindow: 8192,
  signal: new AbortController().signal,
  sink,
  ...over,
});

describe("runTurn", () => {
  it("streams a plain reply and sums usage", async () => {
    const provider = scripted([
      [{ type: "reasoning", text: "r" }, { type: "text", text: "Hello" }, done(3, 2)],
    ]);
    const { log, sink } = recorder();
    const result = await runTurn({ ...base(provider, sink), capabilities: ["completion"] });
    expect(log).toEqual(["think:r", "text:Hello"]);
    expect(result).toMatchObject({ steps: 1, usage: { inputTokens: 3, outputTokens: 2 } });
    expect(provider.requests[0]?.messages[0]).toEqual({ role: "system", content: "You are a bot." });
  });

  it("tells the sink each request's tokens as it ends, so a turn stopped later still knows what it spent", async () => {
    const provider = scripted([
      [{ type: "tool_call", call: { id: "c1", name: "echo", arguments: {} } }, done(10, 2)],
      [{ type: "text", text: "Done" }, done(20, 3)],
    ]);
    const { sink } = recorder();
    const spent: number[][] = [];
    sink.usage = (used) => spent.push([used.inputTokens, used.outputTokens]);
    const result = await runTurn({ ...base(provider, sink), tools: echoTools });
    expect(spent).toEqual([
      [10, 2],
      [20, 3],
    ]);
    expect(result).toMatchObject({ usageReported: true, usage: { inputTokens: 30, outputTokens: 5 } });
  });

  it("says when no request reported its tokens, instead of passing zero off as a count", async () => {
    const provider = scripted([
      [
        { type: "text", text: "Hi" },
        { type: "done", finishReason: "stop", usage: null },
      ],
    ]);
    const { sink } = recorder();
    let told = 0;
    sink.usage = () => (told += 1);
    const result = await runTurn({ ...base(provider, sink), capabilities: ["completion"] });
    expect(result).toMatchObject({ usageReported: false, usage: { inputTokens: 0, outputTokens: 0 } });
    expect(told).toBe(0);
  });

  it("runs native tool calls and feeds results back", async () => {
    const provider = scripted([
      [{ type: "tool_call", call: { id: "c1", name: "echo", arguments: { x: 1 } } }, done()],
      [{ type: "text", text: "Done" }, done()],
    ]);
    const { log, sink } = recorder();
    const result = await runTurn({ ...base(provider, sink), tools: echoTools });
    expect(log).toEqual(["start:echo", 'end:done:echo:{"x":1}', "text:Done"]);
    expect(result.steps).toBe(2);
    expect(provider.requests[0]?.tools?.[0]?.name).toBe("echo");
    expect(provider.requests[1]?.messages.slice(-2)).toEqual([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", arguments: { x: 1 } }] },
      { role: "tool", toolCallId: "c1", name: "echo", content: 'echo:{"x":1}' },
    ]);
  });

  it("uses the text protocol for models without tool support and hides the block", async () => {
    const provider = scripted([
      [
        { type: "text", text: "Let me check.\n```to" },
        { type: "text", text: 'ol\n{"name":"echo","arguments":{"y":2}}\n```' },
        done(),
      ],
      [{ type: "text", text: "All set" }, done()],
    ]);
    const { log, sink } = recorder();
    await runTurn({ ...base(provider, sink), capabilities: ["completion"], tools: echoTools });
    expect(log.join("|")).not.toContain("```");
    expect(log).toContain('end:done:echo:{"y":2}');
    const shown = log.filter((line) => line.startsWith("text:")).map((line) => line.slice(5));
    expect(shown.join("")).toBe("Let me check.\nAll set");
    expect(provider.requests[0]?.tools).toBeUndefined();
    expect(provider.requests[0]?.messages[0]?.content).toContain("```tool");
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: 'Result of echo:\necho:{"y":2}',
    });
  });

  it("folds in messages sent while the turn ran", async () => {
    const provider = scripted([
      [{ type: "text", text: "A" }, done()],
      [{ type: "text", text: "B" }, done()],
    ]);
    const { sink } = recorder();
    let queued: ChatMessage[] = [{ role: "user", content: "also this" }];
    const result = await runTurn({
      ...base(provider, sink),
      steer: () => {
        const out = queued;
        queued = [];
        return out;
      },
    });
    expect(result.steps).toBe(2);
    expect(provider.requests[1]?.messages.slice(-2)).toEqual([
      { role: "assistant", content: "A" },
      { role: "user", content: "also this" },
    ]);
  });

  describe("no-progress guard", () => {
    const call = (id: string, args: Record<string, unknown> = {}): StreamChunk[] => [
      { type: "tool_call", call: { id, name: "echo", arguments: args } },
      done(),
    ];

    it("ends the turn when the same call gives the same result three times in a row", async () => {
      const provider = scripted([
        call("a"),
        call("b"),
        call("c"),
        [{ type: "text", text: "It keeps returning the same thing." }, done()],
      ]);
      const { log, sink } = recorder();
      const result = await runTurn({ ...base(provider, sink), tools: echoTools, maxSteps: 12 });
      expect(result.finishReason).toBe("no_progress");
      expect(result.steps).toBe(3);
      // Three tool steps, then one summary call without tools that says why.
      expect(provider.requests).toHaveLength(4);
      expect(provider.requests[3]?.tools).toBeUndefined();
      expect(provider.requests[3]?.messages.at(-1)?.content).toContain("same tool call with the same result");
      expect(log).toContain("text:It keeps returning the same thing.");
      expect(log.at(-1)).toContain("Stopped: the same step gave the same result 3 times");
    });

    it("ends the turn when it goes back and forth between the same two steps", async () => {
      const provider = scripted([
        call("a", { page: "one" }),
        call("b", { page: "two" }),
        call("c", { page: "one" }),
        call("d", { page: "two" }),
        call("e", { page: "one" }),
        call("f", { page: "two" }),
        [{ type: "text", text: "Going round in circles." }, done()],
      ]);
      const { sink } = recorder();
      const result = await runTurn({ ...base(provider, sink), tools: echoTools, maxSteps: 25 });
      expect(result.finishReason).toBe("no_progress");
      expect(result.steps).toBe(6);
    });

    it("does not count calls whose results differ (scrolling, polling)", async () => {
      let n = 0;
      const tools: ToolHost = {
        ...echoTools,
        execute: async () => ({ status: "done", result: `page ${n++}` }),
      };
      const provider = scripted([
        call("a"),
        call("b"),
        call("c"),
        call("d"),
        [{ type: "text", text: "ok" }, done()],
      ]);
      const { sink } = recorder();
      const result = await runTurn({ ...base(provider, sink), tools, maxSteps: 12 });
      expect(result.finishReason).not.toBe("no_progress");
      expect(result.steps).toBe(5);
    });

    it("does not count a look at a page that changed only in its picture", async () => {
      let n = 0;
      const tools: ToolHost = {
        ...echoTools,
        execute: async () => ({
          status: "done",
          result: "the same text",
          images: [{ mediaType: "image/png", data: `frame-${n++}-${"x".repeat(50)}` }],
        }),
      };
      const provider = scripted([call("a"), call("b"), call("c"), [{ type: "text", text: "ok" }, done()]]);
      const { sink } = recorder();
      const result = await runTurn({
        ...base(provider, sink),
        capabilities: ["completion", "tools", "vision"],
        tools,
        maxSteps: 12,
      });
      expect(result.finishReason).not.toBe("no_progress");
    });

    it("treats the same arguments in another key order as the same call, and a repeated error as no progress", async () => {
      const tools: ToolHost = {
        ...echoTools,
        execute: async () => ({ status: "error", result: "Page not found" }),
      };
      const provider = scripted([
        call("a", { url: "x", n: 1 }),
        call("b", { n: 1, url: "x" }),
        call("c", { url: "x", n: 1 }),
        [{ type: "text", text: "Can't open it." }, done()],
      ]);
      const { sink } = recorder();
      const result = await runTurn({ ...base(provider, sink), tools, maxSteps: 12 });
      expect(result.finishReason).toBe("no_progress");
    });

    it("lets a batch finish, so every call still has its result, before ending", async () => {
      const batch: StreamChunk[] = [
        { type: "tool_call", call: { id: "p1", name: "echo", arguments: {} } },
        { type: "tool_call", call: { id: "p2", name: "echo", arguments: {} } },
        done(),
      ];
      const provider = scripted([batch, call("c"), [{ type: "text", text: "stuck" }, done()]]);
      const { sink } = recorder();
      const result = await runTurn({ ...base(provider, sink), tools: echoTools, maxSteps: 12 });
      // p1, p2 (step 1), then c (step 2) is the third identical call.
      expect(result.finishReason).toBe("no_progress");
      const lastRequest = provider.requests.at(-1)!;
      const calls = lastRequest.messages.flatMap((m) => ("toolCalls" in m ? (m.toolCalls ?? []) : []));
      const results = lastRequest.messages.filter((m) => m.role === "tool");
      expect(results).toHaveLength(calls.length);
    });

    it("is quiet about it when the step-limit note is switched off", async () => {
      const provider = scripted([call("a"), call("b"), call("c"), [{ type: "text", text: "done" }, done()]]);
      const { log, sink } = recorder();
      await runTurn({ ...base(provider, sink), tools: echoTools, stepLimitNote: false });
      expect(log.join("")).not.toContain("Stopped:");
    });
  });

  it("stops at the step limit", async () => {
    const loop = () =>
      [{ type: "tool_call", call: { id: "c", name: "echo", arguments: {} } }, done()] as StreamChunk[];
    const provider = scripted([loop(), loop(), [{ type: "text", text: "Found A, not B." }, done()]]);
    const { log, sink } = recorder();
    const result = await runTurn({ ...base(provider, sink), tools: echoTools, maxSteps: 2 });
    expect(result.finishReason).toBe("max_steps");
    // One last call without tools asks for what was found, so the turn doesn't end empty.
    expect(provider.requests[2]?.tools).toBeUndefined();
    expect(provider.requests[2]?.messages.at(-1)?.content).toContain("used all your steps");
    expect(log).toContain("text:Found A, not B.");
    expect(log.at(-1)).toContain("Stopped after 2 steps");
  });

  it("asks again for a written tool call that was cut off instead of showing it", async () => {
    const provider = scripted([
      [{ type: "text", text: 'Looking.<tool_call><function=echo>{"x": "' }, done()],
      [{ type: "text", text: '<tool_call><function=echo>{"x": 1}</function></tool_call>' }, done()],
      [{ type: "text", text: "All done." }, done()],
    ]);
    const { log, sink } = recorder();
    await runTurn({ ...base(provider, sink, { capabilities: ["completion"] }), tools: echoTools });
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain("cut off");
    expect(log.join("")).not.toContain("<tool_call>");
    expect(log).toContain('end:done:echo:{"x":1}');
  });

  it("only sends think to thinking models", async () => {
    const provider = scripted([[done()], [done()]]);
    const { sink } = recorder();
    await runTurn({ ...base(provider, sink), think: false });
    await runTurn({ ...base(provider, sink), capabilities: ["completion", "thinking"], think: false });
    expect(provider.requests[0]?.think).toBeUndefined();
    expect(provider.requests[1]?.think).toBe(false);
  });
});

describe("history", () => {
  const msg = (over: Partial<Message>): Message => ({
    id: "msg_" + "0".repeat(32),
    threadId: "thr_" + "0".repeat(32),
    role: "user",
    botId: null,
    moderator: false,
    parallel: false,
    parallelTools: false,
    parts: [],
    status: "done",
    model: null,
    usage: null,
    replyToId: null,
    reactions: [],
    createdAt: "2026-10-31T00:00:00.000Z",
    ...over,
  });

  it("maps own messages to assistant, replays tools, names other bots, merges user turns", () => {
    const self = "bot_" + "1".repeat(32);
    const other = "bot_" + "2".repeat(32);
    const history = toChatHistory(
      [
        msg({ parts: [{ type: "text", text: "hi" }] }),
        msg({
          role: "bot",
          botId: self,
          parts: [
            { type: "text", text: "checking" },
            { type: "tool", callId: "c1", name: "ls", args: {}, status: "done", result: "a.txt" },
            { type: "text", text: "found a.txt" },
          ],
        }),
        msg({ role: "bot", botId: other, parts: [{ type: "text", text: "me too" }] }),
        msg({ parts: [{ type: "text", text: "thanks" }] }),
      ],
      self,
      new Map([[other, "Helper"]]),
    );
    expect(history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "checking", toolCalls: [{ id: "c1", name: "ls", arguments: {} }] },
      { role: "tool", toolCallId: "c1", name: "ls", content: "a.txt" },
      { role: "assistant", content: "found a.txt" },
      { role: "user", content: "[Helper]: me too\n\nthanks" },
    ]);
  });

  it("replays a tool call with the signature Gemini gave it", () => {
    const self = "bot_" + "1".repeat(32);
    const history = toChatHistory(
      [
        msg({
          role: "bot",
          botId: self,
          parts: [
            {
              type: "tool",
              callId: "c1",
              name: "list_files",
              args: { path: "." },
              status: "done",
              result: "(empty folder)",
              signature: "sig-abc",
            },
          ],
        }),
      ],
      self,
      new Map(),
    );
    expect(history[0]).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "list_files", arguments: { path: "." }, signature: "sig-abc" }],
    });
  });

  it("tells a moderator's summary from a deleted bot's message", () => {
    const self = "bot_" + "1".repeat(32);
    const history = toChatHistory(
      [
        msg({ role: "bot", moderator: true, parts: [{ type: "text", text: "summary" }] }),
        msg({ role: "bot", parts: [{ type: "text", text: "old reply" }] }),
      ],
      self,
      new Map(),
    );
    expect(history).toEqual([
      { role: "user", content: "[Moderator]: summary\n\n[A former member]: old reply" },
    ]);
  });

  it("drops the oldest messages to fit, keeping the newest and never starting on a tool result", () => {
    const long = "x".repeat(3500);
    const history: ChatMessage[] = [
      { role: "user", content: long },
      { role: "assistant", content: "", toolCalls: [{ id: "c", name: "t", arguments: {} }] },
      { role: "tool", toolCallId: "c", name: "t", content: long },
      { role: "user", content: "latest" },
    ];
    const { messages, dropped } = fitHistory(history, 1100);
    expect(messages.at(-1)).toEqual({ role: "user", content: "latest" });
    expect(messages[0]?.role).not.toBe("tool");
    expect(dropped).toBeGreaterThan(0);
  });
});

describe("FenceFilter", () => {
  it("passes text and holds back a fence split across chunks", () => {
    const filter = new FenceFilter();
    const out =
      ["Hello ", "wor", "ld ``", "`tool {", "}"].map((t) => filter.push(t)).join("") + filter.flush();
    expect(out).toBe("Hello world ");
  });
});

describe("unreadable model output", () => {
  it("retries a step whose tool call the runtime couldn't parse, then falls back to plain text", async () => {
    const requests: ChatRequest[] = [];
    let calls = 0;
    const provider: ChatProvider = {
      id: "flaky",
      label: "Flaky",
      kind: "ollama",
      local: true,
      listModels: async () => [],
      async *chat(request) {
        requests.push(request);
        calls += 1;
        if (calls <= 2) throw new ProviderError("bad_output", "XML syntax error on line 4");
        yield { type: "text", text: "Plain answer" };
        yield done();
      },
    };
    const { log, sink } = recorder();
    await runTurn({ ...base(provider, sink), tools: echoTools });
    expect(calls).toBe(3);
    expect(requests[0]?.tools).toBeDefined();
    expect(requests[2]?.tools).toBeUndefined();
    expect(requests[2]?.messages.at(-1)?.content).toContain("Answer in plain text");
    expect(log.map((line) => line.replace(/^text:/, "")).join("")).toBe("Plain answer");
  });
});

describe("silent endings", () => {
  it("asks once to continue when a model goes quiet after using tools", async () => {
    const provider = scripted([
      [{ type: "tool_call", call: { id: "c1", name: "echo", arguments: {} } }, done()],
      [done()],
      [{ type: "text", text: "Finished." }, done()],
    ]);
    const { log, sink } = recorder();
    const result = await runTurn({ ...base(provider, sink), tools: echoTools });
    expect(log.at(-1)).toBe("text:Finished.");
    expect(result.steps).toBe(3);
    expect(provider.requests[2]?.messages.at(-1)?.content).toContain("You stopped without replying");
  });

  it("does not nudge a plain empty reply without tool use, and only nudges once", async () => {
    const provider = scripted([[done()]]);
    const { sink } = recorder();
    expect((await runTurn({ ...base(provider, sink), tools: echoTools })).steps).toBe(1);

    const quiet = scripted([
      [{ type: "tool_call", call: { id: "c", name: "echo", arguments: {} } }, done()],
      [done()],
      [done()],
    ]);
    expect((await runTurn({ ...base(quiet, sink), tools: echoTools })).steps).toBe(3);
  });
});

describe("tool calls written as text", () => {
  it("understands the formats models are trained on, several per reply", async () => {
    const { parseToolCalls } = await import(".");
    const text = [
      "Sure, creating both now.",
      '<tool_call><function=spawn_bot>{"name": "a", "instructions": "x"}</function></tool_call>',
      '<tool_call>{"name": "spawn_bot", "arguments": {"name": "b", "instructions": "y"}}</tool_call>',
      "<function=delegate><parameter=bot_name>a</parameter><parameter=count>3</parameter></function>",
      '```tool\n{"name": "echo", "parameters": {"z": true}}\n```',
    ].join("\n");
    const { calls, cleaned } = parseToolCalls(text);
    expect(calls.map((c) => [c.name, c.arguments])).toEqual([
      ["spawn_bot", { name: "a", instructions: "x" }],
      ["spawn_bot", { name: "b", instructions: "y" }],
      ["delegate", { bot_name: "a", count: 3 }],
      ["echo", { z: true }],
    ]);
    expect(cleaned).toBe("Sure, creating both now.");
  });

  it("runs MiMo-style calls from a model without native tools and hides the tags", async () => {
    const provider = scripted([
      [
        { type: "text", text: "On it.<tool_call><function=ec" },
        {
          type: "text",
          text: 'ho>{"q": 1}</function></tool_call><tool_call><function=echo>{"q": 2}</function></tool_call>',
        },
        done(),
      ],
      [{ type: "text", text: "Both done." }, done()],
    ]);
    const { log, sink } = recorder();
    await runTurn({ ...base(provider, sink), capabilities: ["completion"], tools: echoTools });
    expect(log.join("|")).not.toContain("<tool_call");
    expect(log.filter((l) => l.startsWith("end:"))).toEqual([
      'end:done:echo:{"q":1}',
      'end:done:echo:{"q":2}',
    ]);
    expect(
      log
        .filter((l) => l.startsWith("text:"))
        .map((l) => l.slice(5))
        .join(""),
    ).toBe("On it.Both done.");
  });

  it("catches a call a tools-capable model leaked into its text, and shows text that only looked like one", async () => {
    const leaked = scripted([
      [{ type: "text", text: '<tool_call>{"name": "echo", "arguments": {}}</tool_call>' }, done()],
      [{ type: "text", text: "ok" }, done()],
    ]);
    const first = recorder();
    await runTurn({ ...base(leaked, first.sink), tools: echoTools });
    expect(first.log).toContain("end:done:echo:{}");

    const lookalike = scripted([[{ type: "text", text: "Use <function=foo> carefully" }, done()]]);
    const second = recorder();
    await runTurn({ ...base(lookalike, second.sink), tools: echoTools });
    expect(
      second.log
        .filter((l) => l.startsWith("text:"))
        .map((l) => l.slice(5))
        .join(""),
    ).toBe("Use <function=foo> carefully");
  });
});

describe("sloppy written calls", () => {
  it("ignores stray characters after the JSON", async () => {
    const { parseToolCalls } = await import(".");
    const { calls } = parseToolCalls(
      '<tool_call><function=delegate>{"tasks":[{"bot_name":"A","task":"x {y}"}]}\n}</function></tool_call>',
    );
    expect(calls[0]).toMatchObject({
      name: "delegate",
      arguments: { tasks: [{ bot_name: "A", task: "x {y}" }] },
    });
  });
});

describe("room in long turns", () => {
  it("shortens the oldest tool results first and keeps the newest", async () => {
    const { shrinkOldResults } = await import("./budget");
    const big = "x".repeat(7000);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      { role: "tool", toolCallId: "1", name: "a", content: big },
      { role: "tool", toolCallId: "2", name: "b", content: big },
      { role: "tool", toolCallId: "3", name: "c", content: big },
      { role: "tool", toolCallId: "4", name: "d", content: big },
    ];
    expect(shrinkOldResults(messages, 5000)).toBe(2);
    expect(messages[2]?.content).toContain("older result shortened");
    expect(messages[5]?.content).toBe(big);
    expect(shrinkOldResults(messages, 100_000)).toBe(0);
  });
});

describe("self-check", () => {
  // Distinct arguments each time: three identical calls in a row would trip the no-progress guard instead.
  let calls = 0;
  const callEcho = () =>
    [
      { type: "tool_call", call: { id: "c", name: "echo", arguments: { n: ++calls } } },
      done(),
    ] as StreamChunk[];
  const say = (text: string) => [{ type: "text", text }, done()] as StreamChunk[];

  it("checks a tool-heavy answer once and shows nothing when it stands", async () => {
    const provider = scripted([callEcho(), callEcho(), callEcho(), say("Answer."), say("OK")]);
    const { log, sink } = recorder();
    await runTurn({ ...base(provider, sink), tools: echoTools, selfCheck: true });
    expect(provider.requests).toHaveLength(5);
    expect(provider.requests[4]?.messages.at(-1)?.content).toContain("check your answer");
    expect(log.filter((l) => l.startsWith("text:")).join("")).toBe("text:Answer.");
  });

  it("shows corrections under a heading", async () => {
    const provider = scripted([callEcho(), callEcho(), callEcho(), say("Answer."), say("Price was Rs. 5.")]);
    const { log, sink } = recorder();
    await runTurn({ ...base(provider, sink), tools: echoTools, selfCheck: true });
    expect(log.at(-1)).toBe("text:\n\n**After checking:** Price was Rs. 5.");
  });

  it("can go back to its tools after checking", async () => {
    const provider = scripted([
      callEcho(),
      callEcho(),
      callEcho(),
      say("Answer."),
      callEcho(),
      say("Fixed."),
    ]);
    const { log, sink } = recorder();
    await runTurn({ ...base(provider, sink), tools: echoTools, selfCheck: true });
    expect(provider.requests).toHaveLength(6);
    expect(log.at(-1)).toBe("text:Fixed.");
  });

  it("skips the check for short tasks", async () => {
    const provider = scripted([callEcho(), say("Answer.")]);
    const { sink } = recorder();
    await runTurn({ ...base(provider, sink), tools: echoTools, selfCheck: true });
    expect(provider.requests).toHaveLength(2);
  });
});

describe("screenshots in long turns", () => {
  it("keeps only the newest tool screenshots and never the user's own pictures", async () => {
    const { dropOldPictures } = await import("./budget");
    const picture = [{ mediaType: "image/jpeg", data: "x" }];
    const messages: ChatMessage[] = [
      { role: "user", content: "what's in this photo?", images: picture },
      { role: "user", content: "(Picture from screen_look)", images: picture },
      { role: "user", content: "Result of screen_click:\nok", images: picture },
      { role: "user", content: "(Picture from screen_look)", images: picture },
    ];
    expect(dropOldPictures(messages, 2)).toBe(1);
    expect(messages[0]).toMatchObject({ images: picture });
    expect(messages[1]).toEqual({
      role: "user",
      content: "(Picture from screen_look) (older screenshot removed)",
    });
    expect(messages[3]).toMatchObject({ images: picture });
  });
});

describe("announced but not done", () => {
  it("spots a reply that stops while announcing its next move", async () => {
    const { announcesMove } = await import("./turn");
    expect(
      announcesMove(
        "I will click box 6 to focus and type my search query into it, then press enter using Enter key in",
      ),
    ).toBe(true);
    expect(announcesMove("Let me open the first result")).toBe(true);
    expect(announcesMove("The battery is 5,500 mAh. I'll keep this in mind.")).toBe(false);
    expect(announcesMove("| Phone | Price |")).toBe(false);
  });

  it("doesn't take a finished answer that ends with an offer or a list for an unfinished one", async () => {
    const { announcesMove } = await import("./turn");
    for (const finished of [
      "I checked both sites. Here is what I found:\n- Site A: £20\n- Site B: £25\nLet me know if you want more detail",
      "Here are the results. Next, I recommend checking the pricing page:\n- Plan A\n- Plan B",
      "All three prices are below. Let me know if you'd like a chart 🙂",
      "The report is ready. I'd suggest reading the summary first",
    ])
      expect(announcesMove(finished)).toBe(false);
    expect(announcesMove("Found the page.\nNow I'll open the pricing tab")).toBe(true);
  });

  it("asks once to carry on, then accepts the answer", async () => {
    const provider = scripted([
      [{ type: "tool_call", call: { id: "c", name: "echo", arguments: {} } }, done()],
      [{ type: "text", text: "Now I click the first result" }, done()],
      [{ type: "text", text: "Done: it costs Rs. 5." }, done()],
    ]);
    const { log, sink } = recorder();
    await runTurn({ ...base(provider, sink), tools: echoTools });
    expect(provider.requests).toHaveLength(3);
    expect(log.at(-1)).toBe("text:Done: it costs Rs. 5.");
  });
});

describe("audit fixes", () => {
  it("records a written tool call as the model's text, not as native toolCalls", async () => {
    const provider = scripted([
      [{ type: "text", text: '```tool\n{"name":"echo","arguments":{"y":2}}\n```' }, done()],
      [{ type: "text", text: "All set" }, done()],
    ]);
    const { sink } = recorder();
    await runTurn({ ...base(provider, sink), capabilities: ["completion"], tools: echoTools });
    const assistant = provider.requests[1]!.messages.find((message) => message.role === "assistant");
    expect(assistant).toEqual({
      role: "assistant",
      content: '```tool\n{"name":"echo","arguments":{"y":2}}\n```',
    });
  });

  it("does not run the rest of a batch of tool calls after Stop", async () => {
    const controller = new AbortController();
    const ran: string[] = [];
    const tools: ToolHost = {
      definitions: echoTools.definitions,
      execute: async (call) => {
        ran.push(call.id);
        controller.abort();
        return { status: "done", result: "ok" };
      },
    };
    const provider = scripted([
      [
        { type: "tool_call", call: { id: "a", name: "echo", arguments: {} } },
        { type: "tool_call", call: { id: "b", name: "echo", arguments: {} } },
        done(),
      ],
    ]);
    const { sink } = recorder();
    await expect(
      runTurn({ ...base(provider, sink), tools, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(ran).toEqual(["a"]);
  });

  it("doesn't nudge on the last step, so a finished answer isn't followed by an out-of-steps note", async () => {
    const provider = scripted([
      [{ type: "tool_call", call: { id: "c", name: "echo", arguments: {} } }, done()],
      [{ type: "text", text: "Next, I will check it" }, done()],
    ]);
    const { log, sink } = recorder();
    const result = await runTurn({ ...base(provider, sink), tools: echoTools, maxSteps: 2 });
    expect(provider.requests).toHaveLength(2);
    expect(result.finishReason).not.toBe("max_steps");
    expect(log.join("")).not.toContain("Stopped after");
  });

  it("sends the provider's thinking blocks back with the step's tool calls", async () => {
    const block = { type: "thinking", thinking: "hmm", signature: "sig" };
    const provider = scripted([
      [
        { type: "thinking_block", block },
        { type: "tool_call", call: { id: "c", name: "echo", arguments: {} } },
        done(),
      ],
      [{ type: "text", text: "ok" }, done()],
    ]);
    const { sink } = recorder();
    await runTurn({ ...base(provider, sink), tools: echoTools });
    const assistant = provider.requests[1]!.messages.find((message) => message.role === "assistant");
    expect(assistant).toMatchObject({ thinking: [block] });
  });
});

describe("history summaries", () => {
  const say = (n: number): ChatMessage => ({ role: "user", content: `message ${n} ${"x".repeat(300)}` });

  it("finds where the summary ended even after the window of loaded messages moved on", async () => {
    const { compactHistory } = await import("./compact");
    const summarized: string[] = [];
    const summarize = async (text: string) => {
      summarized.push(text);
      return `summary ${summarized.length}`;
    };
    const first = Array.from({ length: 40 }, (_, n) => say(n));
    const one = await compactHistory(first, 1000, summarize);
    expect(one.cache?.mark).toBeDefined();
    // Two new messages arrive and the two oldest fall out of the loaded window.
    const second = [...first.slice(2), say(40), say(41)];
    await compactHistory(second, 1000, summarize, one.cache);
    const covered = one.cache!.covered;
    // The second summary picks up right after the last message the first one covered: nothing skipped or repeated.
    expect(summarized[1]).toContain(`message ${covered} `);
    expect(summarized[1]).not.toContain(`message ${covered - 1} `);
    expect(summarized[1]).toContain("Summary so far:\nsummary 1");
  });

  it("cuts the new messages, never the summary so far", async () => {
    const { compactHistory } = await import("./compact");
    let sent = "";
    const history = Array.from({ length: 400 }, (_, n) => say(n));
    await compactHistory(history, 2000, async (text) => ((sent = text), "s"), {
      covered: 1,
      summary: "OLD FACTS",
      last: undefined,
    });
    expect(sent.startsWith("Summary so far:\nOLD FACTS")).toBe(true);
  });
});

describe("pictures", () => {
  const picture = [{ mediaType: "image/png", data: "AAA" }];

  it("sends a batch's screenshots after its last tool result", async () => {
    const tools: ToolHost = {
      definitions: echoTools.definitions,
      execute: async () => ({ status: "done", result: "shot", images: picture }),
    };
    const provider = scripted([
      [
        { type: "tool_call", call: { id: "a", name: "echo", arguments: {} } },
        { type: "tool_call", call: { id: "b", name: "echo", arguments: {} } },
        done(),
      ],
      [{ type: "text", text: "ok" }, done()],
    ]);
    const { sink } = recorder();
    await runTurn({ ...base(provider, sink), capabilities: ["completion", "tools", "vision"], tools });
    expect(provider.requests[1]!.messages.slice(-5).map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "user",
      "user",
    ]);
  });

  it("leaves the user's pictures out for a model that can't see, and says so", async () => {
    const provider = scripted([[{ type: "text", text: "ok" }, done()]]);
    const { sink } = recorder();
    await runTurn({
      ...base(provider, sink),
      history: [{ role: "user", content: "what's this?", images: picture }],
    });
    expect(provider.requests[0]!.messages.at(-1)).toEqual({
      role: "user",
      content: "what's this?\n(picture omitted: this model can't see images)",
    });
  });

  it("keeps the user's own pictures when shrinking old results", async () => {
    const { shrinkOldResults } = await import("./budget");
    const big = "x".repeat(7000);
    const messages: ChatMessage[] = [
      { role: "user", content: "compare with this", images: picture },
      { role: "tool", toolCallId: "1", name: "a", content: big },
      { role: "user", content: "(Picture from screen_look)", images: picture },
      { role: "tool", toolCallId: "2", name: "b", content: big },
      { role: "tool", toolCallId: "3", name: "c", content: big },
      { role: "user", content: "go on" },
    ];
    shrinkOldResults(messages, 1000);
    expect(messages[0]).toMatchObject({ images: picture });
    expect(messages[2]).toEqual({
      role: "user",
      content: "(Picture from screen_look) (picture removed to save room)",
    });
  });
});

describe("text-tool models and earlier turns", () => {
  it("replays earlier native tool use in the written form", async () => {
    const provider = scripted([[{ type: "text", text: "ok" }, done()]]);
    const { sink } = recorder();
    await runTurn({
      ...base(provider, sink),
      capabilities: ["completion"],
      tools: echoTools,
      history: [
        { role: "user", content: "list" },
        {
          role: "assistant",
          content: "Looking.",
          toolCalls: [{ id: "c1", name: "ls", arguments: { p: "." } }],
        },
        { role: "tool", toolCallId: "c1", name: "ls", content: "a.txt" },
        { role: "assistant", content: "Found a.txt" },
        { role: "user", content: "thanks" },
      ],
    });
    const sent = provider.requests[0]!.messages.slice(1);
    expect(sent.some((message) => message.role === "tool" || "toolCalls" in message)).toBe(false);
    expect(sent[1]).toEqual({
      role: "assistant",
      content: 'Looking.\n```tool\n{"name":"ls","arguments":{"p":"."}}\n```',
    });
    expect(sent[2]).toEqual({ role: "user", content: "Result of ls:\na.txt" });
  });

  it("reads a written call whose arguments contain a code fence", async () => {
    const { parseToolCalls } = await import(".");
    const content = "# Notes\n```js\nconsole.log(1)\n```\n";
    const call = JSON.stringify({ name: "write_file", arguments: { path: "a.md", content } });
    const { calls, cleaned } = parseToolCalls(`Writing it.\n\`\`\`tool\n${call}\n\`\`\`\nDone soon.`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "write_file", arguments: { path: "a.md", content } });
    expect(cleaned).toBe("Writing it.\n\nDone soon.");
  });
});

describe("retries and the last step", () => {
  it("drops a failed attempt's thinking before the retry", async () => {
    const stale = { type: "thinking", thinking: "old", signature: "s1" };
    const fresh = { type: "thinking", thinking: "new", signature: "s2" };
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      id: "flaky",
      label: "Flaky",
      kind: "anthropic",
      local: false,
      listModels: async () => [],
      async *chat(request) {
        requests.push(structuredClone({ ...request, signal: undefined }));
        if (requests.length === 1) {
          yield { type: "reasoning", text: "old" };
          yield { type: "thinking_block", block: stale };
          throw new ProviderError("bad_output", "bad tool json");
        }
        if (requests.length === 2) {
          yield { type: "thinking_block", block: fresh };
          yield { type: "tool_call", call: { id: "c", name: "echo", arguments: {} } };
          yield done();
          return;
        }
        yield { type: "text", text: "ok" };
        yield done();
      },
    };
    const { log, sink } = recorder();
    const withDiscard: TurnSink = { ...sink, discardReasoning: () => log.push("discard") };
    await runTurn({ ...base(provider, withDiscard), tools: echoTools });
    const assistant = requests[2]!.messages.find((message) => message.role === "assistant");
    expect(assistant).toMatchObject({ thinking: [fresh] });
    expect(log.slice(0, 2)).toEqual(["think:old", "discard"]);
  });

  it("leaves a message sent during the last step for a fresh turn", async () => {
    const queue: ChatMessage[] = [];
    const replies: StreamChunk[][] = [
      [{ type: "tool_call", call: { id: "c", name: "echo", arguments: {} } }, done()],
      [{ type: "text", text: "Done." }, done()],
    ];
    let requests = 0;
    const provider: ChatProvider = {
      id: "fake",
      label: "Fake",
      kind: "ollama",
      local: true,
      listModels: async () => [],
      async *chat() {
        requests += 1;
        if (requests === 2) queue.push({ role: "user", content: "one more thing" });
        for (const chunk of replies.shift() ?? []) yield chunk;
      },
    };
    const { log, sink } = recorder();
    const result = await runTurn({
      ...base(provider, sink),
      tools: echoTools,
      maxSteps: 2,
      steer: () => queue.splice(0),
    });
    expect(requests).toBe(2);
    expect(result.finishReason).not.toBe("max_steps");
    expect(log.join("")).not.toContain("Stopped after");
    expect(queue).toEqual([{ role: "user", content: "one more thing" }]);
  });
});

describe("history summaries with repeated text", () => {
  const self = "bot_" + "1".repeat(32);
  const stored = (n: number, text: string): Message => ({
    id: `msg_${String(n).padStart(32, "0")}`,
    threadId: "thr_" + "0".repeat(32),
    role: n % 2 ? "bot" : "user",
    botId: n % 2 ? self : null,
    moderator: false,
    parallel: false,
    parallelTools: false,
    parts: [{ type: "text", text }],
    status: "done",
    model: null,
    usage: null,
    replyToId: null,
    reactions: [],
    createdAt: "2026-10-31T00:00:00.000Z",
  });

  it("picks up right after the summarized part when every message reads the same", async () => {
    const { compactHistory } = await import("./compact");
    const summarized: string[] = [];
    const summarize = async (text: string) => (summarized.push(text), `summary ${summarized.length}`);
    const note = `Routine check: all good. ${"x".repeat(300)}`;
    const all = Array.from({ length: 42 }, (_, n) => stored(n, note));
    const names = new Map<string, string>();
    const one = await compactHistory(toChatHistory(all.slice(0, 40), self, names), 1000, summarize);
    // Two new messages arrive and the two oldest fall out of the loaded window.
    await compactHistory(toChatHistory(all.slice(2), self, names), 1000, summarize, one.cache);
    expect(summarized).toHaveLength(2);
    expect(summarized[1]!.split("New messages:\n")[1]!.split("\n")).toHaveLength(2);
  });

  it("tells repeated replies apart by the messages before them when there are no ids", async () => {
    const { compactHistory } = await import("./compact");
    const summarized: string[] = [];
    const summarize = async (text: string) => (summarized.push(text), `summary ${summarized.length}`);
    const say = (n: number): ChatMessage[] => [
      { role: "user", content: `question ${n} ${"x".repeat(300)}` },
      { role: "assistant", content: `ok ${"y".repeat(300)}` },
    ];
    const first = Array.from({ length: 20 }, (_, n) => say(n)).flat();
    const one = await compactHistory(first, 1000, summarize);
    await compactHistory([...first.slice(2), ...say(20)], 1000, summarize, one.cache);
    const covered = one.cache!.covered;
    // The first summary ended on an "ok"; the next one starts with the question after it, not a later one.
    expect(covered % 2).toBe(0);
    expect(summarized[1]!.split("New messages:\n")[1]).toMatch(new RegExp(`^user: question ${covered / 2} `));
  });

  it("still reads a cache saved in the older shape and moves it to the new one", async () => {
    const { compactHistory } = await import("./compact");
    const history = Array.from({ length: 40 }, (_, n): ChatMessage => ({
      role: "user",
      content: `message ${n} ${"x".repeat(300)}`,
    }));
    const boundary = history[29]!;
    const last = `user:${boundary.content.length}:${boundary.content.slice(0, 200)}:`;
    let sent = "";
    const result = await compactHistory(history, 1000, async (text) => ((sent = text), "s2"), {
      covered: 30,
      summary: "OLD",
      last,
    });
    expect(sent).toMatch(/^Summary so far:\nOLD\n\nNew messages:\nuser: message 30 /);
    expect(result.cache).toMatchObject({ summary: "s2", mark: expect.any(String) });
  });
});

describe("one-shot questions", () => {
  it("asks with a system prompt and returns the reply's text", async () => {
    const { askWith } = await import(".");
    const provider = scripted([[{ type: "text", text: "Ada" }, done()]]);
    const reply = await askWith(provider, "m", "Pick one.", "Who answers?", {
      signal: new AbortController().signal,
      maxTokens: 20,
    });
    expect(reply).toBe("Ada");
    expect(provider.requests[0]).toMatchObject({
      maxTokens: 20,
      messages: [
        { role: "system", content: "Pick one." },
        { role: "user", content: "Who answers?" },
      ],
    });
  });
});
