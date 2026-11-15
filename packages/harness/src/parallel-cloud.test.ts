import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, groupByLane, messageText, type Bot, type Message } from "@mrog/shared";

import { readLaneHeader } from "./parallel-lanes";
import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An OpenAI-style stream. */
const sse = (text: string) =>
  new Response(
    new Blob([
      [
        { choices: [{ delta: { content: text } }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
        "[DONE]",
      ]
        .map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`)
        .join(""),
    ]).stream(),
  );

interface Req {
  kind: "roles" | "lane" | "single" | "plain";
  lane: number;
  body: any;
  text: string;
  from: number;
  to: number;
}

const ROLES =
  "1. Cost analyst | the money side\n2. Security engineer | the risks\n3. Skeptic | what could go wrong";
const THREE = "## 1. Cost analyst\nBuy.\n\n## 2. Security engineer\nPatch.\n\n## 3. Skeptic\nWait.";
const answer = (lane: number) => `Answer ${lane} ANSWER-MARK-${lane}.`;

interface Options {
  delayMs?: number;
  lane?: (req: Req) => Response | Promise<Response>;
}

/** A cloud provider (Groq's API, faked) that tells the roles request, the roles and other requests apart. */
async function cloud(options: Options = {}, settings: Record<string, unknown> = {}) {
  const requests: Req[] = [];
  let inFlight = 0;
  let peak = 0;
  const chat = async (body: any) => {
    const messages: { role: string; content: string }[] = body.messages;
    const last = messages.findLast((m) => m.role === "user")?.content ?? "";
    const lane = Number(/Parallel Bots, role ([1-3]) of 3/.exec(last)?.[1] ?? 0);
    const kind: Req["kind"] = (messages[0]?.content ?? "").startsWith("You pick three roles")
      ? "roles"
      : lane
        ? "lane"
        : last.includes("Parallel Bots mode")
          ? "single"
          : "plain";
    const req: Req = { kind, lane, body, text: JSON.stringify(messages), from: Date.now(), to: 0 };
    requests.push(req);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      await sleep(options.delayMs ?? 0);
      if (kind === "roles") return sse(ROLES);
      if (kind === "single") return sse(THREE);
      if (kind === "plain") return sse("Plain answer.");
      return options.lane ? await options.lane(req) : sse(answer(lane));
    } finally {
      inFlight -= 1;
      req.to = Date.now();
    }
  };
  h = await makeHarness({
    handlers: {
      ...fakeOllama(() => ndjson([{ message: { content: THREE } }, { done: true }])),
      "api.groq.com/openai/v1/models": () => Response.json({ data: [{ id: "llama-3.3-70b-versatile" }] }),
      "api.groq.com/openai/v1/chat/completions": chat,
    },
  });
  h.store.settings.set("runtime", {
    ...DEFAULT_RUNTIME_SETTINGS,
    sharedModel: "ollama:test:1b",
    ...settings,
  });
  h.services.turns.laneStaggerMs = 0;
  await h.app.inject({
    method: "POST",
    url: "/api/providers",
    headers: auth,
    payload: { preset: "groq", apiKey: "k" },
  });
  const bot = (
    await h.app.inject({
      method: "POST",
      url: "/api/bots",
      headers: auth,
      payload: { name: "Cloudy", model: "groq:llama-3.3-70b-versatile" },
    })
  ).json().bot as Bot;
  return { requests, peak: () => peak, bot };
}

const send = (bot: Bot, payload: object = {}) =>
  h!.app.inject({
    method: "POST",
    url: `/api/threads/${bot.threadId}/messages`,
    headers: auth,
    payload: { text: "Should we move to our own servers?", parallel: true, ...payload },
  });

const finished = (botId: string, seen: string[] = []) =>
  nextEvent<Message>(
    h!.bus,
    (e) =>
      e.type === "message.updated" &&
      e.message.botId === botId &&
      e.message.status !== "streaming" &&
      !seen.includes(e.message.id) &&
      e.message,
    10_000,
  );

const answerOf = (message: Message, lane: number) => {
  const parts = groupByLane(message.parts).lanes[lane - 1]!;
  return parts
    .filter((part) => part.type === "text")
    .slice(1)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
};

describe("Parallel Bots on a cloud model", () => {
  it("asks the three roles in separate requests at the same time, without tools", async () => {
    const { requests, peak, bot } = await cloud({ delayMs: 400 });
    const done = finished(bot.id);
    expect((await send(bot)).statusCode).toBe(201);
    const reply = await done;

    expect(reply).toMatchObject({ status: "done", parallel: true, parallelTools: false });
    expect(requests.map((r) => r.kind).toSorted()).toEqual(["lane", "lane", "lane", "roles"]);
    // No tools anywhere: not in the roles request and not in any role's.
    for (const request of requests) expect(request.body.tools).toBeUndefined();
    // The three were in flight together: about 0.4 s for the roles, not 1.2 s.
    const lanes = requests.filter((r) => r.kind === "lane");
    expect(peak()).toBe(3);
    expect(Math.max(...lanes.map((r) => r.from))).toBeLessThan(Math.min(...lanes.map((r) => r.to)));
    expect(Math.max(...lanes.map((r) => r.to)) - Math.min(...lanes.map((r) => r.from))).toBeLessThan(800);
    // No role sees another's answer; each gets its own role and a note without tool lines.
    for (const request of lanes) {
      for (const other of [1, 2, 3].filter((n) => n !== request.lane))
        expect(request.text).not.toContain(`ANSWER-MARK-${other}`);
      const note = request.body.messages.findLast((m: { role: string }) => m.role === "user").content;
      expect(note.startsWith("Should we move to our own servers?")).toBe(true);
      expect(note).not.toContain("web_search");
      expect(note).not.toContain("steps");
      expect(note).not.toContain("results you got");
      expect(note).not.toContain("tools");
    }
    expect(lanes.find((r) => r.lane === 2)!.body.messages.at(-1).content).toContain(
      "(Parallel Bots, role 2 of 3. You are the Security engineer. Your focus: the risks. Two other roles are answering the same message separately. You can't see them, so don't mention them or repeat what they might say. Write your complete answer from this role's point of view, as long as the message needs. Don't write a heading or the role name: the app adds them.)",
    );

    // The same lane-tagged shape as the tools mode: a heading marked done, then the answer.
    const { lanes: parts, shared } = groupByLane(reply.parts);
    expect(shared).toEqual([]);
    for (const lane of [1, 2, 3]) {
      const heading = parts[lane - 1]![0]!;
      expect(heading).toMatchObject({ type: "text", lane, laneDone: true });
      expect(readLaneHeader((heading as { text: string }).text)?.index).toBe(lane);
      expect(answerOf(reply, lane)).toBe(answer(lane));
    }
  });

  it("streams each role's text into a part already tagged with its lane", async () => {
    const { bot } = await cloud();
    let whole: Message["parts"] = [];
    const untagged: number[] = [];
    let deltas = 0;
    h!.bus.subscribe((e) => {
      if ((e.type === "message.created" || e.type === "message.updated") && e.message.botId === bot.id)
        whole = e.message.parts;
      else if (e.type === "message.delta") {
        deltas += 1;
        const part = whole[e.partIndex];
        if (!part || !("lane" in part) || !part.lane) untagged.push(e.partIndex);
      }
    });
    const done = finished(bot.id);
    await send(bot);
    await done;
    expect(deltas).toBeGreaterThanOrEqual(3);
    expect(untagged).toEqual([]);
  });

  it("keeps an address a role writes from memory: there are no pages to check it against", async () => {
    const { bot } = await cloud({ lane: () => sse("See https://docs.example.com/guide for more.") });
    const done = finished(bot.id);
    await send(bot);
    const reply = await done;
    expect(answerOf(reply, 1)).toContain("https://docs.example.com/guide");
  });

  it("lets one role fail without stopping the others", async () => {
    const { bot } = await cloud({
      lane: (req) =>
        req.lane === 2
          ? new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 500 })
          : sse(answer(req.lane)),
    });
    const done = finished(bot.id);
    await send(bot);
    const reply = await done;
    expect(reply.status).toBe("done");
    const { lanes } = groupByLane(reply.parts);
    expect(lanes[1]!.some((part) => part.type === "error")).toBe(true);
    expect(answerOf(reply, 1)).toBe(answer(1));
    expect(answerOf(reply, 3)).toBe(answer(3));
    expect(lanes.every((lane) => lane[0]?.type === "text" && lane[0].laneDone)).toBe(true);
  });

  it("stops every role on Stop", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { requests, bot } = await cloud({
      lane: async (req) => {
        await gate;
        return sse(answer(req.lane));
      },
    });
    const done = finished(bot.id);
    await send(bot);
    await vi.waitFor(() => expect(requests.filter((r) => r.kind === "lane")).toHaveLength(3));
    await h!.app.inject({ method: "POST", url: `/api/threads/${bot.threadId}/stop`, headers: auth });
    release();
    const reply = await done;
    expect(reply.status).toBe("stopped");
    expect(requests).toHaveLength(4);
  });

  it("keeps the mode when a failed reply is tried again", async () => {
    let failing = true;
    const { requests, bot } = await cloud({
      lane: (req) =>
        failing
          ? new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 })
          : sse(answer(req.lane)),
    });
    const failed = finished(bot.id);
    await send(bot);
    const first = await failed;
    expect(first.status).toBe("error");
    failing = false;
    const again = finished(bot.id, [first.id]);
    const res = await h!.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/retry`,
      headers: auth,
      payload: { botId: bot.id, messageId: first.id },
    });
    expect(res.statusCode).toBe(202);
    const second = await again;
    expect(second).toMatchObject({ status: "done", parallel: true, parallelTools: false });
    expect(requests.filter((r) => r.kind === "roles")).toHaveLength(2);
    expect(requests.filter((r) => r.kind === "single")).toHaveLength(0);
    for (const lane of [1, 2, 3]) expect(answerOf(second, lane)).toBe(answer(lane));
  });

  it("never steers a message into the running roles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { requests, bot } = await cloud({
      lane: async (req) => {
        await gate;
        return sse(answer(req.lane));
      },
    });
    const first = finished(bot.id);
    await send(bot);
    await vi.waitFor(() => expect(requests.filter((r) => r.kind === "lane")).toHaveLength(3));
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "One more thing" },
    });
    release();
    const reply = await first;
    expect(reply.parallel).toBe(true);
    expect(requests.filter((r) => r.kind === "lane").some((r) => r.text.includes("One more thing"))).toBe(
      false,
    );
  });

  it("gives later turns only the three roles' answers as sections", async () => {
    const { requests, bot } = await cloud();
    const first = finished(bot.id);
    await send(bot);
    const reply = await first;
    const next = finished(bot.id, [reply.id]);
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "And in one line?" },
    });
    await next;
    const plain = requests.findLast((r) => r.kind === "plain")!;
    const said = plain.body.messages.find((m: { role: string }) => m.role === "assistant").content as string;
    expect(said).toBe(
      `## Cost analyst\n${answer(1)}\n\n## Security engineer\n${answer(2)}\n\n## Skeptic\n${answer(3)}`,
    );
    expect(plain.text).not.toContain("the money side");
    expect(plain.text).not.toContain("role 1 of 3");
  });

  it("asks in one combined request when the setting is off, as before", async () => {
    const { requests, bot } = await cloud({}, { parallelSeparateOnCloud: false });
    const done = finished(bot.id);
    await send(bot);
    const reply = await done;
    expect(requests.map((r) => r.kind)).toEqual(["single"]);
    expect(requests[0]!.body.tools).toBeUndefined();
    expect(messageText(reply)).toBe(THREE);
    expect(groupByLane(reply.parts).shared).toHaveLength(1);
    expect(reply).toMatchObject({ parallel: true, parallelTools: false });
  });
});

describe("Parallel Bots on a local model", () => {
  it("keeps the single request with the setting on", async () => {
    const { bot: _cloudBot } = await cloud();
    const local = (
      await h!.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ada" } })
    ).json().bot as Bot;
    const done = finished(local.id);
    await send(local);
    const reply = await done;
    const chats = h!.calls.filter((call) => call.path === "/api/chat");
    expect(chats).toHaveLength(1);
    expect(chats[0]!.body.messages.at(-1).content).toContain("Parallel Bots mode");
    expect(messageText(reply)).toBe(THREE);
    expect(reply.parts.some((part) => "lane" in part && part.lane)).toBe(false);
  });
});

describe("the parallelSeparateOnCloud setting", () => {
  it("goes through the runtime route like the others, and must be true or false", async () => {
    await cloud();
    const off = await h!.app.inject({
      method: "PATCH",
      url: "/api/runtime/settings",
      headers: auth,
      payload: { parallelSeparateOnCloud: false },
    });
    expect(off.json().settings.parallelSeparateOnCloud).toBe(false);
    const status = await h!.app.inject({ url: "/api/runtime", headers: auth });
    expect(status.json().status.settings.parallelSeparateOnCloud).toBe(false);
    for (const bad of ["yes", 1, null])
      expect(
        (
          await h!.app.inject({
            method: "PATCH",
            url: "/api/runtime/settings",
            headers: auth,
            payload: { parallelSeparateOnCloud: bad },
          })
        ).statusCode,
      ).toBe(400);
  });
});
