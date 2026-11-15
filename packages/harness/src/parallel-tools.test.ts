import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, groupByLane, messageText, type Bot, type Message } from "@mrog/shared";

import { BrowserManager } from "./browser";
import { readLaneHeader } from "./parallel-lanes";
import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Rows = unknown[];
interface Req {
  kind: "roles" | "lane" | "plain";
  lane: number;
  /** 1 for a role's first request, 2 after its first tool result, and so on. */
  step: number;
  /** Everything the model was sent, as text. */
  text: string;
  tools: string[];
  body: any;
}

const ROLES =
  "1. Cost analyst | the money side\n2. Security engineer | the risks\n3. Skeptic | what could go wrong";
const call = (name: string, args: unknown): Rows => [
  { message: { tool_calls: [{ function: { name, arguments: args } }] } },
];
const say = (text: string): Rows => [{ message: { content: text } }];
const answer = (lane: number) => `Answer ${lane} MARKER-ANS-${lane} from MARKER-RES-${lane}.`;

interface TeamOptions {
  roles?: string | (() => Response);
  /** A role's reply; the default searches once, then answers. */
  lane?: (req: Req) => Rows | Response | Promise<Rows | Response>;
  /** How the ordinary (non-parallel) replies go. */
  plain?: (req: Req) => Rows;
}

/** A fake model that tells roles, lanes and ordinary requests apart, and records each. */
function team(options: TeamOptions = {}) {
  const requests: Req[] = [];
  let inFlight = 0;
  let peak = 0;
  const handlers = fakeOllama(async (body) => {
    const messages: { role: string; content: string }[] = body.messages;
    const system = messages[0]?.content ?? "";
    const laneNote = messages.findLast(
      (m) => m.role === "user" && /Parallel Bots, role [1-3] of 3/.test(m.content),
    );
    const lane = Number(/role ([1-3]) of 3/.exec(laneNote?.content ?? "")?.[1] ?? 0);
    const kind: Req["kind"] = system.startsWith("You pick three roles") ? "roles" : lane ? "lane" : "plain";
    const req: Req = {
      kind,
      lane,
      step: messages.filter((m) => m.role === "tool").length + 1,
      text: JSON.stringify(messages),
      tools: (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
      body,
    };
    requests.push(req);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      let out: Rows | Response;
      if (kind === "roles") {
        const roles = options.roles ?? ROLES;
        out = typeof roles === "function" ? roles() : say(roles);
      } else if (kind === "plain") out = options.plain ? options.plain(req) : say("Plain answer.");
      else if (options.lane) out = await options.lane(req);
      else out = req.step === 1 ? call("web_search", { query: `q${lane}` }) : say(answer(lane));
      return out instanceof Response ? out : ndjson([...out, { done: true }]);
    } finally {
      inFlight -= 1;
    }
  });
  return { handlers, requests, peak: () => peak };
}

async function start(
  options: TeamOptions = {},
  settings: Record<string, unknown> = {},
  tune?: (harness: TestHarness) => void,
) {
  const t = team(options);
  h = await makeHarness({ handlers: t.handlers });
  h.store.settings.set("runtime", {
    ...DEFAULT_RUNTIME_SETTINGS,
    sharedModel: "ollama:test:1b",
    numCtx: 8192,
    ...settings,
  });
  h.services.turns.laneStaggerMs = 0;
  // A search that takes a while, and remembers which tab asked.
  const searches: { query: string; tab: string; from: number; to: number }[] = [];
  vi.spyOn(h.services.browser, "search").mockImplementation(async (_bot, query, signal, tab) => {
    const lane = Number(tab?.split("#")[1] ?? 0);
    const entry = { query, tab: tab ?? "", from: Date.now(), to: 0 };
    searches.push(entry);
    await sleep(searchMs);
    if (signal.aborted) throw new Error("Stopped.");
    entry.to = Date.now();
    return `Results for ${query}: MARKER-RES-${lane}`;
  });
  tune?.(h);
  const res = await h.app.inject({
    method: "POST",
    url: "/api/bots",
    headers: auth,
    payload: { name: "Ada", isPrimary: true },
  });
  return { ...t, searches, ada: res.json().bot as Bot };
}

let searchMs = 0;

const send = (bot: Bot, payload: object = {}) =>
  h!.app.inject({
    method: "POST",
    url: `/api/threads/${bot.threadId}/messages`,
    headers: auth,
    payload: { text: "Should we move to our own servers?", parallel: true, parallelTools: true, ...payload },
  });

const finished = (seen: string[] = [], timeoutMs = 10_000) =>
  nextEvent<Message>(
    h!.bus,
    (e) =>
      e.type === "message.updated" &&
      e.message.role === "bot" &&
      e.message.status !== "streaming" &&
      !seen.includes(e.message.id) &&
      e.message,
    timeoutMs,
  );

const lanesOf = (message: Message) => groupByLane(message.parts).lanes;
const answerOf = (message: Message, lane: number) => {
  const parts = lanesOf(message)[lane - 1]!;
  // The first text part is the role's heading; the rest is its answer.
  return parts
    .filter((part) => part.type === "text")
    .slice(1)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
};

describe("Parallel Bots with tools", () => {
  it("runs each role as its own conversation: no role ever sees another's searches or answer", async () => {
    const { requests } = await start();
    const done = finished();
    expect((await send(await botOf())).statusCode).toBe(201);
    const reply = await done;

    expect(reply).toMatchObject({ status: "done", parallel: true, parallelTools: true });
    const laneRequests = requests.filter((r) => r.kind === "lane");
    // Three roles, a search and an answer each; plus the one request that picked the roles.
    expect(requests.filter((r) => r.kind === "roles")).toHaveLength(1);
    expect(laneRequests).toHaveLength(6);
    for (const lane of [1, 2, 3]) {
      const mine = laneRequests.filter((r) => r.lane === lane);
      expect(mine).toHaveLength(2);
      // The second request has this role's own result, and nothing of the other two.
      expect(mine[1]!.text).toContain(`MARKER-RES-${lane}`);
      for (const other of [1, 2, 3].filter((n) => n !== lane))
        for (const request of mine) {
          expect(request.text).not.toContain(`MARKER-RES-${other}`);
          expect(request.text).not.toContain(`MARKER-ANS-${other}`);
          expect(request.text).not.toContain(`q${other}`);
        }
    }
    // Each role's card has its own answer, and all three are there.
    for (const lane of [1, 2, 3]) expect(answerOf(reply, lane)).toBe(answer(lane));
  });

  it("writes lane-tagged parts: a heading first, then the role's own tool calls and answer", async () => {
    await start();
    const done = finished();
    await send(await botOf());
    const reply = await done;
    const { lanes, shared } = groupByLane(reply.parts);
    expect(lanes.map((lane) => lane.map((part) => part.type))).toEqual([
      ["text", "tool", "text"],
      ["text", "tool", "text"],
      ["text", "tool", "text"],
    ]);
    expect(readLaneHeader((lanes[0]![0] as { text: string }).text)).toEqual({
      index: 1,
      role: "Cost analyst",
      focus: "the money side",
    });
    const tool = lanes[1]![1]!;
    expect(tool).toMatchObject({ type: "tool", name: "web_search", status: "done", lane: 2 });
    // Unique ids, each carrying its lane, so approval cards and results can't reach the wrong role.
    const ids = reply.parts.flatMap((part) => (part.type === "tool" ? [part.callId] : []));
    expect(new Set(ids).size).toBe(3);
    ids.forEach((id, i) => expect(id.startsWith(`L${i + 1}-`)).toBe(true));
    // The memory note, if any, is the only part without a lane.
    expect(shared.every((part) => part.type === "text")).toBe(true);
  });

  it("announces every new lane part, tagged, before any text streams into it", async () => {
    await start({
      lane: (req) =>
        req.step === 1
          ? call("web_search", { query: `q${req.lane}` })
          : [{ message: { content: "Part one of " } }, { message: { content: `the answer ${req.lane}.` } }],
    });
    // What a screen holds: the last whole message, with each delta merged into it.
    let whole: Message["parts"] = [];
    const untagged: number[] = [];
    h!.bus.subscribe((e) => {
      if (e.type === "message.created" || e.type === "message.updated") {
        if (e.message.role === "bot") whole = e.message.parts;
      } else if (e.type === "message.delta") {
        const part = whole[e.partIndex];
        // The part the text goes into is already there, and says which role it is.
        if (!part || !("lane" in part) || !part.lane) untagged.push(e.partIndex);
      }
    });
    const deltas: number[] = [];
    h!.bus.subscribe((e) => e.type === "message.delta" && deltas.push(e.partIndex));
    const done = finished();
    await send(await botOf());
    const reply = await done;
    expect(deltas.length).toBeGreaterThan(5);
    expect(untagged).toEqual([]);
    for (const lane of [1, 2, 3]) expect(answerOf(reply, lane)).toBe(`Part one of the answer ${lane}.`);
  });

  it("marks each role's heading done when that role is over, while the others may still be writing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await start({
      lane: async (req) => {
        if (req.lane === 3 && req.step === 1) await gate;
        return req.step === 1 ? call("web_search", { query: `q${req.lane}` }) : say(answer(req.lane));
      },
    });
    const headers = (parts: Message["parts"]) =>
      groupByLane(parts).lanes.map((lane) => {
        const head = lane[0];
        return head?.type === "text" && head.laneDone === true;
      });
    let seen: boolean[] = [];
    h!.bus.subscribe((e) => {
      if (e.type === "message.updated" && e.message.role === "bot") seen = headers(e.message.parts);
    });
    const done = finished();
    await send(await botOf());
    await vi.waitFor(() => expect(seen).toEqual([true, true, false]));
    release();
    const reply = await done;
    expect(headers(reply.parts)).toEqual([true, true, true]);
    // A role that failed is over too, and so is one that was stopped.
    expect(reply.parts.filter((part) => part.type === "text" && part.laneDone).length).toBe(3);
  });

  it("offers a role only web_search and fetch_url, and tells it who it is", async () => {
    const { requests } = await start();
    const done = finished();
    await send(await botOf());
    await done;
    for (const request of requests.filter((r) => r.kind === "lane")) {
      expect(request.tools.toSorted()).toEqual(["fetch_url", "web_search"]);
      expect(request.body.messages[0].content).not.toContain("spawn_bot");
      expect(request.body.messages[0].content).not.toContain("Using the web: work like a person");
    }
    const first = requests.find((r) => r.kind === "lane" && r.lane === 2)!;
    const note = first.body.messages.findLast((m: { role: string }) => m.role === "user").content as string;
    expect(note.startsWith("Should we move to our own servers?")).toBe(true);
    expect(note).toContain("You are the Security engineer. Your focus: the risks.");
    expect(note).toMatch(/fetch_url and web_search|web_search and fetch_url/);
    expect(note).toContain("at most 6 steps");
    expect(note).toContain("You can't see them");
    // The roles request has no tools.
    expect(requests.find((r) => r.kind === "roles")!.tools).toEqual([]);
  });

  it("only offers the tools this bot is allowed", async () => {
    const { requests, ada } = await start();
    const patch = await h!.app.inject({
      method: "PATCH",
      url: `/api/bots/${ada.id}`,
      headers: auth,
      payload: { tools: { allow: null, exclude: ["fetch_url"], apps: {} } },
    });
    expect(patch.statusCode).toBe(200);
    const done = finished();
    await send(ada);
    await done;
    for (const request of requests.filter((r) => r.kind === "lane"))
      expect(request.tools).toEqual(["web_search"]);
  });

  it("searches in all three roles at once, each in its own browser tab", async () => {
    searchMs = 500;
    const { searches, ada } = await start();
    const began = Date.now();
    const done = finished();
    await send(ada);
    const reply = await done;
    const took = Date.now() - began;
    searchMs = 0;

    expect(reply.status).toBe("done");
    expect(searches.map((s) => s.tab).toSorted()).toEqual(
      [1, 2, 3].map((n) => BrowserManager.laneTab(ada.id, n)),
    );
    // All three searches were under way at the same moment: about half a second, not one and a half.
    expect(Math.max(...searches.map((s) => s.from))).toBeLessThan(Math.min(...searches.map((s) => s.to)));
    expect(took).toBeLessThan(1300);
    // Their tabs open in the bot's own browser profile.
    for (const n of [1, 2, 3])
      expect(h!.services.browser.profileKey(BrowserManager.laneTab(ada.id, n))).toBe(
        h!.services.browser.profileKey(ada.id),
      );
  });

  it("starts the roles a little apart", async () => {
    const starts: number[] = [];
    await start({
      lane: (req) => {
        if (req.step === 1) starts[req.lane] = Date.now();
        return req.step === 1 ? say(answer(req.lane)) : say("x");
      },
    });
    h!.services.turns.laneStaggerMs = 120;
    const done = finished();
    await send(await botOf());
    await done;
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(100);
    expect(starts[3]! - starts[2]!).toBeGreaterThanOrEqual(100);
  });

  it("lets up to `parallelLanes` requests run at once in the one slot, and one at a time with a single lane", async () => {
    const slow = async (req: Req) => {
      await sleep(120);
      return req.step === 1 ? call("web_search", { query: `q${req.lane}` }) : say(answer(req.lane));
    };
    const three = await start({ lane: slow });
    const first = finished();
    await send(three.ada);
    await first;
    expect(three.peak()).toBe(3);
    await h!.close();

    const one = await start({ lane: slow }, { parallelLanes: 1 });
    const second = finished();
    await send(one.ada);
    expect((await second).status).toBe("done");
    expect(one.peak()).toBe(1);
  });

  it("holds one model slot for the whole turn and frees it while every role waits on a search", async () => {
    searchMs = 400;
    const { ada, searches } = await start();
    const other = (
      await h!.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Bea" } })
    ).json().bot as Bot;
    const hers = (id: string) =>
      nextEvent<Message>(
        h!.bus,
        (e) =>
          e.type === "message.updated" &&
          e.message.botId === id &&
          e.message.status !== "streaming" &&
          e.message,
        10_000,
      );
    const first = hers(ada.id);
    await send(ada);
    // Every role is searching, so no model request is in flight and the slot is free: another bot's reply goes through.
    await vi.waitFor(() => expect(searches).toHaveLength(3));
    const bea = hers(other.id);
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${other.threadId}/messages`,
      headers: auth,
      payload: { text: "hi" },
    });
    const reply = await bea;
    expect(messageText(reply)).toBe("Plain answer.");
    // ... while the roles' searches were still going on.
    expect(searches.every((search) => search.to === 0)).toBe(true);
    const parallel = await first;
    searchMs = 0;
    expect(parallel).toMatchObject({ status: "done", parallelTools: true });
  });

  it("cuts a long page for the model but keeps the whole result on the card", async () => {
    const { requests } = await start();
    vi.mocked(h!.services.browser.search).mockImplementation(async (_bot, _query, _signal, tab) => {
      return `PAGE-START ${"y".repeat(12_000)} PAGE-END ${tab}`;
    });
    const done = finished();
    await send(await botOf());
    const reply = await done;
    for (const lane of [1, 2, 3]) {
      const second = requests.find((r) => r.lane === lane && r.step === 2)!;
      const sent = (
        second.body.messages.find((m: { role: string }) => m.role === "tool") as { content: string }
      ).content;
      expect(sent.length).toBeLessThan(4300);
      expect(sent).toContain("PAGE-START");
      expect(sent).toContain("(cut: ");
      expect(sent).not.toContain("PAGE-END");
    }
    const card = lanesOf(reply)[0]!.find((part) => part.type === "tool");
    expect(card?.type === "tool" && card.result).toContain("PAGE-END");
  });

  it("gives a failed or blocked search back as an error and lets the role carry on and answer", async () => {
    await start();
    vi.mocked(h!.services.browser.search).mockImplementation(async (_bot, _query, _signal, tab) => {
      if (tab?.endsWith("#2"))
        throw new Error("The search engine wants a human check, so this search couldn't be done.");
      return "fine";
    });
    const done = finished();
    await send(await botOf());
    const reply = await done;
    const search = lanesOf(reply)[1]!.find((part) => part.type === "tool");
    expect(search).toMatchObject({ status: "error", lane: 2 });
    expect(search?.type === "tool" && search.result).toContain("human check");
    expect(reply.status).toBe("done");
    // The role asked for nothing more and answered; no hand-off card was raised.
    expect(answerOf(reply, 2)).toBe(answer(2));
    expect(reply.parts.some((part) => part.type === "tool" && part.name === "browser_handoff")).toBe(false);
    expect(lanesOf(reply)[1]!.some((part) => part.type === "error")).toBe(false);
  });

  it("stops at the step limit with a nudge to answer", async () => {
    const { requests } = await start(
      {
        lane: (req) =>
          req.tools.length > 0
            ? call("web_search", { query: `q${req.lane}-${req.step}` })
            : say(answer(req.lane)),
      },
      { parallelSteps: 2 },
    );
    const done = finished();
    await send(await botOf());
    const reply = await done;
    expect(reply.status).toBe("done");
    for (const lane of [1, 2, 3]) {
      const mine = requests.filter((r) => r.lane === lane);
      // Two steps with tools, then one last request without them.
      expect(mine.map((r) => r.tools.length > 0)).toEqual([true, true, false]);
      expect(mine.at(-1)!.text).toContain("You've used all your steps");
      expect(lanesOf(reply)[lane - 1]!.filter((part) => part.type === "tool")).toHaveLength(2);
      expect(answerOf(reply, lane)).toBe(answer(lane));
    }
  });

  it("lets one role fail without stopping the others", async () => {
    const { requests } = await start({
      lane: (req) =>
        req.lane === 2
          ? new Response(JSON.stringify({ error: "the model fell over" }), { status: 500 })
          : req.step === 1
            ? call("web_search", { query: `q${req.lane}` })
            : say(answer(req.lane)),
    });
    const done = finished();
    await send(await botOf());
    const reply = await done;

    expect(reply.status).toBe("done");
    const lanes = lanesOf(reply);
    expect(lanes[1]!.some((part) => part.type === "error")).toBe(true);
    expect(lanes[0]!.some((part) => part.type === "error")).toBe(false);
    expect(lanes[2]!.some((part) => part.type === "error")).toBe(false);
    expect(answerOf(reply, 1)).toBe(answer(1));
    expect(answerOf(reply, 3)).toBe(answer(3));
    expect(requests.filter((r) => r.lane === 1)).toHaveLength(2);
    // The error is the role's alone: no error without a lane.
    expect(groupByLane(reply.parts).shared.some((part) => part.type === "error")).toBe(false);
  });

  it("ends in error, with a retry, when every role fails", async () => {
    await start({ lane: () => new Response(JSON.stringify({ error: "down" }), { status: 500 }) });
    const done = finished();
    await send(await botOf());
    const reply = await done;
    expect(reply.status).toBe("error");
    expect(lanesOf(reply).every((lane) => lane.some((part) => part.type === "error"))).toBe(true);
  });

  it("uses fallback roles when the model's roles can't be read", async () => {
    await start({ roles: "I'm not sure what you mean!" });
    const done = finished();
    await send(await botOf());
    const reply = await done;
    const roles = lanesOf(reply).map((lane) => readLaneHeader((lane[0] as { text: string }).text)?.role);
    expect(roles).toEqual(["Analyst", "Critic", "Practical advisor"]);
    expect(reply.status).toBe("done");
  });

  it("falls back when the roles request itself fails", async () => {
    await start({ roles: () => new Response("nope", { status: 500 }) });
    const done = finished();
    await send(await botOf());
    const reply = await done;
    expect(reply.status).toBe("done");
    expect(lanesOf(reply).every((lane) => lane.length > 0)).toBe(true);
  });

  it("checks each role's links against its own pages only", async () => {
    const A = "https://a.example.com/page1";
    const B = "https://b.example.com/page2";
    const { ada } = await start({
      lane: (req) => {
        if (req.step === 1) return call("web_search", { query: `q${req.lane}` });
        if (req.lane === 1) return say(`See [A](${A}) and [B](${B}) and ${B}.`);
        if (req.lane === 2) return say(`See [B](${B}) and [A](${A}).`);
        return say(`No sources. Your own link was ${A}.`);
      },
    });
    vi.mocked(h!.services.browser.search).mockImplementation(async (_bot, query, _signal, tab) => {
      const lane = Number(tab?.split("#")[1]);
      return `Results for ${query}: ${lane === 1 ? A : lane === 2 ? B : "nothing"}`;
    });
    const done = finished();
    await send(ada);
    const reply = await done;
    // Role 1 opened A only: B (opened by role 2) is not a source it can cite.
    expect(answerOf(reply, 1)).toContain(`[A](${A})`);
    expect(answerOf(reply, 1)).not.toContain(B);
    expect(answerOf(reply, 1)).toContain("B (no address given)");
    expect(answerOf(reply, 2)).toContain(`[B](${B})`);
    expect(answerOf(reply, 2)).toContain("A (no address given)");
    expect(answerOf(reply, 3)).not.toContain(A);
  });

  it("keeps the user's own links in a role's answer", async () => {
    const U = "https://docs.example.com/guide";
    await start({ lane: () => say(`Read ${U} first.`) });
    const done = finished();
    await send(await botOf(), { text: `Is ${U} any good?` });
    const reply = await done;
    expect(answerOf(reply, 1)).toContain(U);
  });

  it("gives later turns only each role's final answer, never its searches", async () => {
    const { requests } = await start();
    const first = finished();
    await send(await botOf());
    const reply = await first;
    const followUp = finished([reply.id]);
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${(await botOf()).threadId}/messages`,
      headers: auth,
      payload: { text: "And in one line?" },
    });
    await followUp;
    const plain = requests.findLast((r) => r.kind === "plain")!;
    const roles = plain.body.messages.filter((m: { role: string }) => m.role !== "system");
    expect(roles.some((m: { role: string }) => m.role === "tool")).toBe(false);
    expect(plain.text).not.toContain("tool_calls");
    expect(plain.text).not.toContain("Results for q");
    expect(plain.text).toContain("## Cost analyst");
    expect(plain.text).toContain("MARKER-ANS-1");
    expect(plain.text).toContain("## Skeptic");
    expect(plain.text).not.toContain("the money side");
  });

  it("stops every role at once on Stop", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { requests, ada } = await start({
      lane: async (req) => {
        await gate;
        return say(answer(req.lane));
      },
    });
    const done = finished();
    await send(ada);
    await vi.waitFor(() => expect(requests.filter((r) => r.kind === "lane")).toHaveLength(3));
    const before = requests.length;
    expect(
      (await h!.app.inject({ method: "POST", url: `/api/threads/${ada.threadId}/stop`, headers: auth }))
        .statusCode,
    ).toBe(204);
    release();
    const reply = await done;
    expect(reply.status).toBe("stopped");
    expect(requests).toHaveLength(before);
    expect(reply.parts.some((part) => part.type === "tool" && part.status === "running")).toBe(false);
  });

  it("answers an approval card in the role it belongs to", async () => {
    const { ada } = await start({
      lane: (req) =>
        req.step === 1
          ? req.lane === 2
            ? call("fetch_url", { url: "http://192.168.1.20/admin" })
            : call("web_search", { query: `q${req.lane}` })
          : say(answer(req.lane)),
    });
    const card = nextEvent<{ id: string; callId: string }>(h!.bus, (e) => {
      if (e.type !== "message.updated") return false;
      const part = e.message.parts.find(
        (p: { type: string; status?: string }) => p.type === "tool" && p.status === "pending_approval",
      );
      return part?.type === "tool" && part.approval ? { id: part.approval.id, callId: part.callId } : false;
    });
    const done = finished();
    await send(ada);
    const pending = await card;
    expect(pending.callId.startsWith("L2-")).toBe(true);
    await h!.app.inject({
      method: "POST",
      url: `/api/approvals/${pending.id}`,
      headers: auth,
      payload: { decision: "deny" },
    });
    const reply = await done;
    const fetches = reply.parts.filter((part) => part.type === "tool" && part.name === "fetch_url");
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatchObject({ lane: 2, status: "denied" });
    // The other roles were not held up, and their cards were not touched.
    expect(answerOf(reply, 1)).toBe(answer(1));
    expect(answerOf(reply, 3)).toBe(answer(3));
  });

  it("never steers a message into a running roles reply, and the next message gets its own turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { requests, ada } = await start({
      lane: async (req) => {
        if (req.step === 1) await gate;
        return say(answer(req.lane));
      },
    });
    const first = finished();
    await send(ada);
    await vi.waitFor(() => expect(requests.filter((r) => r.kind === "lane")).toHaveLength(3));
    const second = finished();
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${ada.threadId}/messages`,
      headers: auth,
      payload: { text: "One more thing" },
    });
    release();
    const reply = await first;
    expect(reply.parallelTools).toBe(true);
    // No lane request carries the extra message.
    expect(requests.filter((r) => r.kind === "lane").some((r) => r.text.includes("One more thing"))).toBe(
      false,
    );
    expect(messageText(await second)).toBeTruthy();
  });

  it("says nothing about a large context that fits on the GPU, nor with a single lane", async () => {
    const onGpu = (harness: TestHarness) => {
      harness.services.runtime.ollama.ps = async () => [
        { name: "test:1b", sizeBytes: 1000, vramBytes: 1000, contextLength: 32768, expiresAt: null },
      ];
    };
    await start({}, { numCtx: 32768 }, onGpu);
    const quiet = finished();
    await send(await botOf());
    const reply = await quiet;
    expect(reply.parts[0]).toMatchObject({ lane: 1 });
    expect(reply.parts.some((part) => part.type === "text" && part.text.startsWith("Heads up"))).toBe(false);
    await h!.close();

    await start({}, { numCtx: 32768, parallelLanes: 1 }, (harness) => {
      harness.services.runtime.ollama.ps = async () => [
        { name: "test:1b", sizeBytes: 1000, vramBytes: 100, contextLength: 32768, expiresAt: null },
      ];
    });
    const single = finished();
    await send(await botOf());
    expect((await single).parts[0]).toMatchObject({ lane: 1 });
  });

  it("warns when the local model is not fully on the GPU", async () => {
    const t = team();
    t.handlers["/api/ps"] = () =>
      Response.json({ models: [{ name: "test:1b", size: 1000, size_vram: 400, context_length: 8192 }] });
    h = await makeHarness({ handlers: t.handlers });
    h.store.settings.set("runtime", {
      ...DEFAULT_RUNTIME_SETTINGS,
      sharedModel: "ollama:test:1b",
      numCtx: 8192,
    });
    h.services.turns.laneStaggerMs = 0;
    vi.spyOn(h.services.browser, "search").mockResolvedValue("ok");
    const ada = (
      await h.app.inject({
        method: "POST",
        url: "/api/bots",
        headers: auth,
        payload: { name: "Ada", isPrimary: true },
      })
    ).json().bot as Bot;
    const done = finished();
    await send(ada);
    const reply = await done;
    const first = reply.parts[0]!;
    // One note, without a lane, at the top; it never stops the run.
    expect(first.type === "text" && !first.lane && first.text).toContain(
      "the model isn't fully on the GPU (40% of it is",
    );
    expect((first as { text: string }).text).toContain("Settings → Local model");
    expect((first as { text: string }).text).toContain("OLLAMA_NUM_PARALLEL to 3");
    expect(
      reply.parts.filter((part) => part.type === "text" && part.text.startsWith("Heads up")),
    ).toHaveLength(1);
    expect(reply.status).toBe("done");
  });
});

describe("Allow tools: refusals and settings", () => {
  const post = (threadId: string, payload: object) =>
    h!.app.inject({ method: "POST", url: `/api/threads/${threadId}/messages`, headers: auth, payload });

  it("refuses Allow tools without Parallel", async () => {
    const { ada } = await start();
    const res = await post(ada.threadId, { text: "hi", parallelTools: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("Allow tools works together with Parallel Bots: turn Parallel on first.");
    expect(h!.store.messages.list(ada.threadId)).toHaveLength(0);
  });

  it("refuses it in a chat with several bots", async () => {
    const { ada } = await start();
    const bea = (
      await h!.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Bea" } })
    ).json().bot as Bot;
    const group = h!.store.threads.createGroup(null, [ada.id, bea.id]);
    const withParallel = await post(group.id, { text: "hi", parallel: true, parallelTools: true });
    expect(withParallel.statusCode).toBe(400);
    expect(withParallel.json().message).toContain("one bot");
    const without = await post(group.id, { text: "hi", parallelTools: true });
    expect(without.statusCode).toBe(400);
  });

  it("refuses it for a Visual Bot and for a Coding Bot", async () => {
    const { ada } = await start();
    const visual = (
      await h!.app.inject({
        method: "POST",
        url: "/api/bots",
        headers: auth,
        payload: { name: "Vis", visual: true },
      })
    ).json().bot as Bot;
    const res = await post(visual.threadId, { text: "hi", parallel: true, parallelTools: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe(
      "Allow tools isn't available for a Visual Bot: it uses the web by looking at the screen, not with search and fetch_url.",
    );
    const coding = h!.store.bots.create({ name: "Builder", coding: true });
    const refused = await post(coding.threadId, { text: "hi", parallel: true, parallelTools: true });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toBe("Allow tools isn't available for a Coding Bot.");
    expect(h!.store.messages.list(visual.threadId)).toHaveLength(0);
    expect(ada.id).toBeTruthy();
  });

  it("refuses it when the bot has neither web_search nor fetch_url", async () => {
    const { ada } = await start();
    await h!.app.inject({
      method: "PATCH",
      url: `/api/bots/${ada.id}`,
      headers: auth,
      payload: { tools: { allow: null, exclude: ["web_search", "fetch_url"], apps: {} } },
    });
    const res = await post(ada.threadId, { text: "hi", parallel: true, parallelTools: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe(
      "Allow tools needs web_search or fetch_url, and this bot has neither turned on (see its Tools).",
    );
    // One of the two is enough.
    await h!.app.inject({
      method: "PATCH",
      url: `/api/bots/${ada.id}`,
      headers: auth,
      payload: { tools: { allow: null, exclude: ["web_search"], apps: {} } },
    });
    expect((await post(ada.threadId, { text: "hi", parallel: true, parallelTools: true })).statusCode).toBe(
      201,
    );
  });

  it("takes the lanes and steps settings through the runtime route like the others", async () => {
    await start();
    const res = await h!.app.inject({
      method: "PATCH",
      url: "/api/runtime/settings",
      headers: auth,
      payload: { parallelLanes: 2, parallelSteps: 8 },
    });
    expect(res.json().settings).toMatchObject({ parallelLanes: 2, parallelSteps: 8 });
    const status = await h!.app.inject({ url: "/api/runtime", headers: auth });
    expect(status.json().status.settings).toMatchObject({ parallelLanes: 2, parallelSteps: 8 });
    for (const bad of [
      { parallelLanes: 4 },
      { parallelLanes: 0 },
      { parallelSteps: 11 },
      { parallelSteps: 0 },
    ])
      expect(
        (await h!.app.inject({ method: "PATCH", url: "/api/runtime/settings", headers: auth, payload: bad }))
          .statusCode,
      ).toBe(400);
  });

  it("uses the steps setting for the roles", async () => {
    const { requests } = await start({}, { parallelSteps: 8 });
    const done = finished();
    await send(await botOf());
    await done;
    const note = requests
      .find((r) => r.kind === "lane")!
      .body.messages.findLast((m: { role: string }) => m.role === "user");
    expect(note.content).toContain("at most 8 steps");
  });
});

describe("Allow tools: retry", () => {
  it("keeps the mode when a failed reply is tried again, and runs every role again", async () => {
    let failing = true;
    const { requests, ada } = await start({
      lane: (req) =>
        failing
          ? new Response(JSON.stringify({ error: "down" }), { status: 500 })
          : req.step === 1
            ? call("web_search", { query: `q${req.lane}` })
            : say(answer(req.lane)),
    });
    const failed = finished();
    await send(ada);
    const first = await failed;
    expect(first.status).toBe("error");
    failing = false;
    const again = finished([first.id]);
    const res = await h!.app.inject({
      method: "POST",
      url: `/api/threads/${ada.threadId}/retry`,
      headers: auth,
      payload: { botId: ada.id, messageId: first.id },
    });
    expect(res.statusCode).toBe(202);
    const second = await again;
    expect(second).toMatchObject({ status: "done", parallel: true, parallelTools: true });
    expect(requests.filter((r) => r.kind === "roles")).toHaveLength(2);
    for (const lane of [1, 2, 3]) expect(answerOf(second, lane)).toBe(answer(lane));
  });

  it("is not refused after a role opened a page (a read), but still is after an action that may repeat", async () => {
    const { ada } = await start();
    const bot = (id: string) => h!.store.bots.get(id)!;
    const fetched = (outward: boolean, name = "fetch_url", parallelTools = true) =>
      h!.store.messages.create({
        threadId: ada.threadId,
        role: "bot",
        botId: ada.id,
        parallel: true,
        parallelTools,
        status: "error",
        parts: [
          {
            type: "tool",
            lane: 1,
            callId: "L1-x",
            name,
            args: { url: "http://192.168.1.20/" },
            status: "done",
            result: "page",
            outward,
          },
        ],
      });
    await send(ada).catch(() => {});
    h!.services.turns.stop(ada.threadId);
    h!.store.messages.clear(ada.threadId);
    h!.store.messages.create({
      threadId: ada.threadId,
      role: "user",
      parts: [{ type: "text", text: "q" }],
      parallel: true,
      parallelTools: true,
    });
    const retry = (message: Message) =>
      h!.app.inject({
        method: "POST",
        url: `/api/threads/${ada.threadId}/retry`,
        headers: auth,
        payload: { botId: bot(ada.id).id, messageId: message.id },
      });
    expect((await retry(fetched(true))).statusCode).toBe(202);
    h!.services.turns.stop(ada.threadId);
    await sleep(50);
    expect((await retry(fetched(true, "run_command"))).statusCode).toBe(409);
    expect((await retry(fetched(true, "fetch_url", false))).statusCode).toBe(409);
  });
});

describe("Races", () => {
  it("still run one at a time on a local model with the new settings present", async () => {
    const t = team({ plain: () => say("Strategy: quick.\nAn answer.") });
    let inFlight = 0;
    let peak = 0;
    const base = t.handlers["/api/chat"]!;
    t.handlers["/api/chat"] = async (body) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(40);
      try {
        return await base(body);
      } finally {
        inFlight -= 1;
      }
    };
    h = await makeHarness({ handlers: t.handlers });
    h.store.settings.set("runtime", {
      ...DEFAULT_RUNTIME_SETTINGS,
      sharedModel: "ollama:test:1b",
      parallelLanes: 3,
      parallelSteps: 6,
    });
    const done = nextEvent(
      h.bus,
      (e) => e.type === "race.updated" && e.race.status === "done" && e.race,
      15_000,
    );
    const res = await h.app.inject({
      method: "POST",
      url: "/api/races",
      headers: auth,
      payload: {
        task: "Name a coffee shop",
        racers: [{ name: "Wren" }, { name: "Kestrel" }, { name: "Robin" }],
        judge: {},
      },
    });
    expect(res.statusCode).toBe(201);
    await done;
    expect(peak).toBe(1);
  });
});

/** The primary bot the tests talk to (made by `start`). */
async function botOf(): Promise<Bot> {
  return h!.store.bots.list().find((bot) => bot.isPrimary)!;
}
