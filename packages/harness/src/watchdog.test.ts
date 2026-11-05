import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProviderError, type ChatProvider, type ChatRequest, type StreamChunk } from "@mrog/providers";
import { DEFAULT_RUNTIME_SETTINGS, type Bot, type Message } from "@mrog/shared";

import { auth, fakeOllama, makeHarness, nextEvent, type TestHarness } from "./testing";
import { watchdogLimits, withWatchdog } from "./watchdog";

const text = (t: string): StreamChunk => ({ type: "text", text: t });
const done: StreamChunk = { type: "done", finishReason: "stop", usage: null };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const request = (signal?: AbortSignal): ChatRequest => ({ model: "m", messages: [], signal });

/** A provider whose reply comes from `run`, which gets the signal the provider was given. */
function provider(run: (signal: AbortSignal | undefined) => AsyncGenerator<StreamChunk>): ChatProvider {
  return {
    id: "fake",
    label: "Fake",
    kind: "ollama",
    local: true,
    listModels: async () => [],
    chat: (req) => run(req.signal),
  };
}

async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of source) out.push(chunk);
  return out;
}

/** What a stream does on abort: throws "aborted", like the real adapters. */
const abortable = (signal: AbortSignal | undefined) =>
  new Promise<never>((_, reject) => {
    signal?.addEventListener("abort", () => reject(new ProviderError("aborted", "Stopped.")), { once: true });
  });

describe("watchdog limits", () => {
  it("gives a model on this computer far longer than one in the cloud", () => {
    // A cold model reading a long prompt, or a long tool call sent only once complete, is silent for minutes.
    expect(watchdogLimits(false)).toEqual({ firstChunkMs: 5 * 60_000, idleMs: 3 * 60_000 });
    const local = watchdogLimits(true);
    expect(local.firstChunkMs).toBeGreaterThanOrEqual(15 * 60_000);
    expect(local.idleMs).toBeGreaterThanOrEqual(8 * 60_000);
    expect(local.firstChunkMs).toBeGreaterThan(watchdogLimits(false).firstChunkMs);
    expect(local.idleMs).toBeGreaterThan(watchdogLimits(false).idleMs);
  });

  it("lets anything set explicitly win, for either kind of provider, one limit at a time", () => {
    expect(watchdogLimits(true, { firstChunkMs: 50 })).toEqual({
      firstChunkMs: 50,
      idleMs: watchdogLimits(true).idleMs,
    });
    expect(watchdogLimits(false, { idleMs: 70 })).toEqual({
      firstChunkMs: watchdogLimits(false).firstChunkMs,
      idleMs: 70,
    });
  });

  it("uses the longer limits for a local provider without being told to", async () => {
    // The fake provider is local and nothing is overridden: a request silent for a while is not cut off.
    const guarded = withWatchdog(
      provider(async function* () {
        await sleep(120);
        yield text("late but fine");
        yield done;
      }),
    );
    expect(await collect(guarded.chat(request()))).toEqual([text("late but fine"), done]);
  });
});

describe("withWatchdog", () => {
  it("passes a normal reply through untouched", async () => {
    const guarded = withWatchdog(
      provider(async function* () {
        yield text("a");
        yield text("b");
        yield done;
      }),
      { firstChunkMs: 200, idleMs: 200 },
    );
    expect(await collect(guarded.chat(request()))).toEqual([text("a"), text("b"), done]);
  });

  it("ends a request that never starts, as stalled, even when the adapter turns the abort into 'aborted'", async () => {
    const guarded = withWatchdog(
      provider(async function* (signal) {
        await abortable(signal); // rejects when aborted: nothing below runs
        yield done;
      }),
      { firstChunkMs: 30, idleMs: 200 },
    );
    const error = await collect(guarded.chat(request())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      code: "stalled",
      message: expect.stringContaining("didn't start replying"),
    });
  });

  it("ends a stream that goes quiet in the middle of a reply", async () => {
    const seen: StreamChunk[] = [];
    const guarded = withWatchdog(
      provider(async function* (signal) {
        yield text("partial");
        await abortable(signal);
      }),
      { firstChunkMs: 200, idleMs: 30 },
    );
    const error = await (async () => {
      try {
        for await (const chunk of guarded.chat(request())) seen.push(chunk);
      } catch (e) {
        return e;
      }
    })();
    expect(seen).toEqual([text("partial")]);
    expect(error).toMatchObject({ code: "stalled", message: expect.stringContaining("went quiet") });
  });

  it("does not trust the adapter to honour the abort: a stream that ignores it is still ended", async () => {
    const guarded = withWatchdog(
      provider(async function* () {
        await new Promise(() => {}); // never settles, never looks at the signal
        yield done;
      }),
      { firstChunkMs: 30, idleMs: 30 },
    );
    const started = Date.now();
    await expect(collect(guarded.chat(request()))).rejects.toMatchObject({ code: "stalled" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("reports a stall even if the adapter swallows the abort and just ends its stream", async () => {
    const guarded = withWatchdog(
      provider(async function* (signal) {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
        // Aborted: ends its stream as if it had finished, without an error.
        if (!signal?.aborted) yield done;
      }),
      { firstChunkMs: 30, idleMs: 30 },
    );
    await expect(collect(guarded.chat(request()))).rejects.toMatchObject({ code: "stalled" });
  });

  it("is not fooled by a slow consumer: only the provider's silence counts", async () => {
    const guarded = withWatchdog(
      provider(async function* () {
        yield text("1");
        yield text("2");
        yield done;
      }),
      { firstChunkMs: 100, idleMs: 100 },
    );
    const out: StreamChunk[] = [];
    for await (const chunk of guarded.chat(request())) {
      out.push(chunk);
      await sleep(150); // the turn is busy handling the chunk, longer than the idle limit
    }
    expect(out).toHaveLength(3);
  });

  it("leaves the user's Stop alone: it stays 'aborted', not 'stalled'", async () => {
    const stop = new AbortController();
    const guarded = withWatchdog(
      provider(async function* (signal) {
        await abortable(signal); // rejects when aborted: nothing below runs
        yield done;
      }),
      { firstChunkMs: 5_000, idleMs: 5_000 },
    );
    setTimeout(() => stop.abort(), 20);
    const error = await collect(guarded.chat(request(stop.signal))).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "aborted" });
  });

  it("gives each request its own clock", async () => {
    const guarded = withWatchdog(
      provider(async function* () {
        await sleep(20);
        yield text("ok");
        yield done;
      }),
      { firstChunkMs: 200, idleMs: 200 },
    );
    const [a, b] = await Promise.all([collect(guarded.chat(request())), collect(guarded.chat(request()))]);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
  });
});

describe("a stalled model in a real turn", () => {
  let h: TestHarness | undefined;
  let dataDir: string;
  afterEach(async () => {
    await h?.close();
    h = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("ends the turn as an error (not 'stopped') and frees the model for the next one", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mrog-stall-"));
    let hang = true;
    h = await makeHarness({
      config: { dataDir },
      // Short enough to see the stall, long enough that a slow CI runner still gets the second reply out in time.
      watchdog: { firstChunkMs: 300, idleMs: 300 },
      handlers: fakeOllama(() =>
        hang
          ? // Headers arrive, then nothing, and the fake fetch never looks at the signal.
            new Response(new ReadableStream({ start() {} }))
          : new Response(
              new Blob([
                `${JSON.stringify({ message: { content: "Back again." } })}\n{"done":true}\n`,
              ]).stream(),
            ),
      ),
    });
    h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    const bot = (
      await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ada" } })
    ).json().bot as Bot;
    const settled = () =>
      nextEvent<Message>(
        h!.bus,
        (e) => e.type === "message.updated" && e.message.status !== "streaming" && e.message,
        5000,
      );
    const send = (message: string) =>
      h!.app.inject({
        method: "POST",
        url: `/api/threads/${bot.threadId}/messages`,
        headers: auth,
        payload: { text: message },
      });

    const first = settled();
    await send("hello");
    const reply = await first;
    expect(reply.status).toBe("error");
    expect(reply.parts.at(-1)).toMatchObject({ type: "error", code: "stalled" });

    // The slot went back: the next message gets an answer instead of queueing behind the dead one.
    hang = false;
    const second = settled();
    await send("again");
    const next = await second;
    expect(next.status).toBe("done");
    expect(next.parts.at(-1)).toEqual({ type: "text", text: "Back again." });
  });
});
