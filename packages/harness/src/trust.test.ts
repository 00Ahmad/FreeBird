import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { DEFAULT_RUNTIME_SETTINGS, type Bot, type Message, type MessagePart } from "@mrog/shared";
import { defineTool, safe, type ApprovalRequest } from "@mrog/tools";

import { ApprovalBroker } from "./agent/approvals";
import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
let dataDir: string | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

type ToolPart = Extract<MessagePart, { type: "tool" }>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ollama that answers each chat request with the next scripted reply. */
function scriptedOllama(replies: unknown[][]) {
  const requests: any[] = [];
  return {
    requests,
    handlers: fakeOllama((body) => {
      requests.push(body);
      return ndjson([
        ...(replies.shift() ?? [{ message: { content: "(no more replies)" } }]),
        { done: true },
      ]);
    }),
  };
}

const toolCall = (name: string, args: Record<string, unknown>) => ({
  message: { tool_calls: [{ function: { name, arguments: args } }] },
});

async function setup(replies: unknown[][] = []) {
  dataDir = mkdtempSync(join(tmpdir(), "mrog-trust-"));
  const ollama = scriptedOllama(replies);
  h = await makeHarness({ config: { dataDir }, handlers: ollama.handlers });
  h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  const bot = (
    await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ada" } })
  ).json().bot as Bot;
  return { bot, requests: ollama.requests };
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

const toolPart = (message: Message) => message.parts.find((p): p is ToolPart => p.type === "tool");

describe("approval cards that nobody answers", () => {
  /** A broker with a short clock, a live card on `msg_x`, and a way to look at the card. */
  function card(
    timeoutMs: number,
    over: { groupChat?: boolean; signal?: AbortSignal; kind?: "general" | "terminal" } = {},
  ) {
    const broker = new ApprovalBroker({
      store: h!.store,
      bus: h!.bus,
      turns: h!.services.turns,
      timeoutMs,
    });
    const part: ToolPart = { type: "tool", callId: "c1", name: "run_command", args: {}, status: "running" };
    let published = 0;
    h!.services.turns.partHooks.set("msg_x", { parts: [part], publish: () => (published += 1) });
    const scope = {
      threadId: "thr_x",
      messageId: "msg_x",
      botId: "bot_x",
      groupChat: over.groupChat ?? false,
      signal: over.signal ?? new AbortController().signal,
    };
    const request = {
      call: { id: "c1", name: "run_command", arguments: {} },
      risk: { level: "ask", kind: over.kind ?? "terminal", badges: [], summary: "echo x" },
    } as unknown as ApprovalRequest;
    return { broker, part, scope, request, published: () => published };
  }

  it("times out as 'timeout' (not a refusal), closes the card and drops a late answer", async () => {
    await setup();
    const { broker, part, scope, request } = card(30);
    const decided = broker.decide(request, scope);
    const id = part.approval!.id;
    expect(await decided).toBe("timeout");
    expect(part).toMatchObject({ status: "denied", decidedBy: "timeout" });
    expect(part).not.toHaveProperty("approval");
    // The card is gone: a click that arrives now finds nothing to answer (the API says 410).
    expect(broker.respond(id, "allow_once")).toBe(false);
  });

  it("lets the user's answer win, and the clock then does nothing", async () => {
    await setup();
    const { broker, part, scope, request, published } = card(40);
    const decided = broker.decide(request, scope);
    expect(broker.respond(part.approval!.id, "allow_once")).toBe(true);
    expect(await decided).toBe("allow");
    const after = published();
    await sleep(120);
    expect(part).toMatchObject({ status: "running", decidedBy: "user" });
    expect(published()).toBe(after); // the timer never touched the card again
  });

  it("lets Stop win over the clock, and a late answer finds nothing", async () => {
    await setup();
    const stop = new AbortController();
    const { broker, part, scope, request } = card(40, { signal: stop.signal });
    const decided = broker.decide(request, scope);
    const id = part.approval!.id;
    stop.abort();
    expect(await decided).toBe("deny");
    expect(part).toMatchObject({ status: "denied", decidedBy: "stopped" });
    await sleep(100);
    expect(part.decidedBy).toBe("stopped");
    expect(broker.respond(id, "allow_once")).toBe(false);
  });

  it("settles only once, whichever of the answer, Stop and the clock comes first", async () => {
    await setup();
    // The answer first: the Stop right after it and the clock later change nothing.
    const stop = new AbortController();
    const answered = card(40, { signal: stop.signal });
    const first = answered.broker.decide(answered.request, answered.scope);
    answered.broker.respond(answered.part.approval!.id, "allow_once");
    stop.abort();
    expect(await first).toBe("allow");
    const settledAt = answered.published();
    await sleep(100);
    expect(answered.published()).toBe(settledAt);
    expect(answered.part).toMatchObject({ status: "running", decidedBy: "user" });

    // The clock first: the answer and the Stop that follow find the card already closed.
    const stop2 = new AbortController();
    const quiet = card(20, { signal: stop2.signal });
    const second = quiet.broker.decide(quiet.request, quiet.scope);
    const id = quiet.part.approval!.id;
    expect(await second).toBe("timeout");
    expect(quiet.broker.respond(id, "allow_once")).toBe(false);
    const closedAt = quiet.published();
    stop2.abort();
    await sleep(20);
    expect(quiet.published()).toBe(closedAt);
    expect(quiet.part).toMatchObject({ status: "denied", decidedBy: "timeout" });
  });

  it("records when a rule, the command policy or the group-chat rule decided instead of the user", async () => {
    await setup();
    const policy = card(1000);
    policy.broker.savePermissions({ localExecution: "always", rules: [] });
    expect(await policy.broker.decide(policy.request, policy.scope)).toBe("allow");
    expect(policy.part.decidedBy).toBe("policy");

    const never = card(1000);
    never.broker.savePermissions({ localExecution: "never", rules: [] });
    expect(await never.broker.decide(never.request, never.scope)).toBe("deny");
    expect(never.part.decidedBy).toBe("policy");

    const rule = card(1000, { kind: "general" });
    rule.broker.savePermissions({ localExecution: "ask", rules: [] });
    rule.broker.addRule({ tool: "run_command", match: "echo x", decision: "allow" });
    expect(await rule.broker.decide(rule.request, rule.scope)).toBe("allow");
    expect(rule.part.decidedBy).toBe("rule");

    const group = card(1000, { groupChat: true });
    group.broker.savePermissions({ localExecution: "ask", rules: [] });
    expect(await group.broker.decide(group.request, group.scope)).toBe("deny");
    expect(group.part.decidedBy).toBe("group_chat");
  });
});

describe("a command that is given secrets", () => {
  it("always shows a card, even with 'always allow commands', and offers no Always allow", async () => {
    await setup();
    const broker = h!.services.agent.approvals;
    broker.savePermissions({ localExecution: "always", rules: [] });
    const parts: MessagePart[] = [
      { type: "tool", callId: "c1", name: "run_command", args: {}, status: "running" },
    ];
    h!.services.turns.partHooks.set("msg_s", { parts, publish: () => {} });
    const scope = {
      threadId: "thr_x",
      messageId: "msg_s",
      botId: "bot_x",
      groupChat: false,
      signal: new AbortController().signal,
    };
    const request = (badges: string[]) =>
      ({
        call: { id: "c1", name: "run_command", arguments: {} },
        risk: {
          level: "ask",
          kind: "terminal",
          badges,
          summary: "gh pr list\n(with your secrets: GH_TOKEN)",
        },
      }) as unknown as ApprovalRequest;

    // A plain command is allowed by the policy without a card.
    expect(await broker.decide(request([]), scope)).toBe("allow");
    // With secrets, the user decides.
    const pending = broker.decide(request(["Gives the command your saved secrets"]), scope);
    const part = parts[0] as ToolPart;
    expect(part.approval).toMatchObject({ canAlways: false });
    broker.respond(part.approval!.id, "deny");
    expect(await pending).toBe("deny");

    // "Never allow commands" still refuses it outright.
    broker.savePermissions({ localExecution: "never", rules: [] });
    expect(await broker.decide(request(["Gives the command your saved secrets"]), scope)).toBe("deny");
  });
});

describe("a bot whose request went unanswered", () => {
  it("is told nobody answered (not that the user said no), now and in later turns", async () => {
    const { bot, requests } = await setup([
      [toolCall("run_command", { command: "echo hi" })],
      [{ message: { content: "I'll wait for you to confirm." } }],
      [{ message: { content: "Understood." } }],
    ]);
    h!.services.agent.approvals.timeoutMs = 60;
    const first = finished();
    await send(bot, "run it");
    const reply = await first;

    expect(toolPart(reply)).toMatchObject({ status: "denied", decidedBy: "timeout" });
    const told = requests[1].messages.at(-1);
    expect(told).toMatchObject({ role: "tool", tool_name: "run_command" });
    expect(told.content).toMatch(/Nobody answered/);
    expect(told.content).not.toMatch(/user denied/i);

    // The next turn replays that call from the saved message: it must still say what really happened.
    const second = finished();
    await send(bot, "thanks");
    await second;
    const replayed = requests[2].messages.find((m: any) => m.role === "tool");
    expect(replayed.content).toMatch(/Nobody answered/);
    expect(replayed.content).not.toMatch(/user denied/i);
  });

  it("keeps waiting, past the usual time, for a bot whose owner chose to wait for approvals", async () => {
    const { bot, requests } = await setup([
      [toolCall("run_command", { command: "echo hi" })],
      [{ message: { content: "Done." } }],
    ]);
    // Switched on through the API, as the Details panel does.
    const patched = await h!.app.inject({
      method: "PATCH",
      url: `/api/bots/${bot.id}`,
      headers: auth,
      payload: { approvalsWait: true },
    });
    expect(patched.json().bot.approvalsWait).toBe(true);
    h!.services.agent.approvals.timeoutMs = 40;
    const card = nextEvent<string>(h!.bus, (e) => {
      if (e.type !== "message.updated") return undefined;
      const part = toolPart(e.message);
      return part?.status === "pending_approval" && part.approval?.id;
    });
    const done = finished();
    await send(bot, "run it");
    const id = await card;
    // Several times the usual wait: before, the call was dropped as "nobody answered".
    await sleep(200);
    const answered = await h!.app.inject({
      method: "POST",
      url: `/api/approvals/${id}`,
      headers: auth,
      payload: { decision: "deny" },
    });
    expect(answered.statusCode).toBe(204);
    expect(toolPart(await done)).toMatchObject({ status: "denied", decidedBy: "user" });
    expect(requests[1].messages.at(-1).content).toMatch(/user denied/i);
  });

  it("still tells the bot the user said no, when the user did", async () => {
    const { bot, requests } = await setup([
      [toolCall("run_command", { command: "echo hi" })],
      [{ message: { content: "OK." } }],
    ]);
    const card = nextEvent<string>(h!.bus, (e) => {
      if (e.type !== "message.updated") return undefined;
      const part = toolPart(e.message);
      return part?.status === "pending_approval" && part.approval?.id;
    });
    const done = finished();
    await send(bot, "run it");
    await h!.app.inject({
      method: "POST",
      url: `/api/approvals/${await card}`,
      headers: auth,
      payload: { decision: "deny" },
    });
    expect(toolPart(await done)).toMatchObject({ status: "denied", decidedBy: "user" });
    expect(requests[1].messages.at(-1).content).toMatch(/user denied/i);
  });
});

describe("a call that acts outside the chat", () => {
  it("is marked on the saved message before it starts, so a restart mid-call can say so", async () => {
    const { bot } = await setup([[toolCall("deploy", {})], [{ message: { content: "Deployed." } }]]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h!.services.agent.toolSources.push(() => [
      defineTool({
        name: "deploy",
        description: "Deploy",
        args: z.object({}),
        // Safe to run without asking, but it acts.
        risk: () => ({ ...safe("Deploy"), outward: true }),
        run: async () => {
          await gate;
          return "deployed";
        },
      }),
    ]);

    const done = finished();
    await send(bot, "deploy it");
    // While the call is hanging, what is in the database is what a crash would leave behind.
    const saved = async () => {
      for (let i = 0; i < 100; i++) {
        const message = h!.store.messages.list(bot.threadId).find((m) => m.role === "bot");
        const part = message && toolPart(message);
        if (part?.outward && part.status === "running") return message!;
        await sleep(20);
      }
      throw new Error("the outward mark was never saved");
    };
    const mid = await saved();
    expect(mid.status).toBe("streaming");

    // A restart now would end it as an error that names the call, not as a quiet "stopped".
    expect(h!.store.messages.recoverInterrupted()).toEqual({ stopped: 0, failed: 1 });
    expect(h!.store.messages.get(mid.id)!.parts.at(-1)).toMatchObject({
      type: "error",
      code: "interrupted",
      message: expect.stringContaining("deploy"),
    });

    release();
    await done;
  });

  it("also marks the coordinator's hand-off, which is all the user's chat shows while a helper acts", async () => {
    const { bot: coordinator } = await setup();
    const helper = (
      await h!.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Bea" } })
    ).json().bot as Bot;
    h!.services.agent.toolSources.push(() => [
      defineTool({
        name: "deploy",
        description: "Deploy",
        args: z.object({}),
        risk: () => ({ ...safe("Deploy"), outward: true }),
        run: async () => "deployed",
      }),
    ]);
    const own: MessagePart[] = [{ type: "tool", callId: "h1", name: "deploy", args: {}, status: "running" }];
    const shown: MessagePart[] = [
      { type: "tool", callId: "d1", name: "delegate", args: {}, status: "running" },
      { type: "tool", callId: "d0", name: "delegate", args: {}, status: "done" },
      { type: "tool", callId: "w1", name: "fetch_url", args: {}, status: "running" },
    ];
    let published = 0;
    h!.services.turns.partHooks.set("msg_own", { parts: own, publish: () => {} });
    h!.services.turns.partHooks.set("msg_coordinator", { parts: shown, publish: () => (published += 1) });

    const host = h!.services.turns.extensions.tools!(
      helper,
      h!.store.threads.get(helper.threadId)!,
      "msg_own",
      new AbortController().signal,
      {
        delegated: true,
        surface: { threadId: coordinator.threadId, messageId: "msg_coordinator", botId: coordinator.id },
      },
    )!;
    await host.execute({ id: "h1", name: "deploy", arguments: {} }, new AbortController().signal);

    expect(own[0]).toMatchObject({ outward: true });
    // Only the hand-off still running; a finished one and an unrelated call are left alone.
    expect(shown[0]).toMatchObject({ callId: "d1", outward: true });
    expect(shown[1]).not.toHaveProperty("outward");
    expect(shown[2]).not.toHaveProperty("outward");
    expect(published).toBe(1);
  });

  it("is not marked for a read-only call", async () => {
    const { bot } = await setup([
      [toolCall("read_file", { path: "nothing.txt" })],
      [{ message: { content: "Nothing there." } }],
    ]);
    const done = finished();
    await send(bot, "read it");
    expect(toolPart(await done)).not.toHaveProperty("outward");
  });
});
