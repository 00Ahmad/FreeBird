import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, type Bot, type Message, type MessagePart } from "@mrog/shared";

import type { ApprovalRequest } from "@mrog/tools";

import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

let h: TestHarness | undefined;
let dataDir: string;
afterEach(async () => {
  await h?.close();
  h = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

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

async function setup(replies: unknown[][]) {
  dataDir = mkdtempSync(join(tmpdir(), "mrog-agent-"));
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

const toolPart = (message: Message) =>
  message.parts.find((p): p is Extract<MessagePart, { type: "tool" }> => p.type === "tool");

const pendingApproval = () =>
  nextEvent<NonNullable<Extract<MessagePart, { type: "tool" }>["approval"]>>(h!.bus, (e) => {
    if (e.type !== "message.updated") return undefined;
    const part = toolPart(e.message);
    return part?.status === "pending_approval" && part.approval;
  });

describe("agent tools", () => {
  it("writes into the bot's own folder without asking and tells the model the result", async () => {
    const { bot, requests } = await setup([
      [toolCall("write_file", { path: "hello.txt", content: "hi there" })],
      [{ message: { content: "Saved it." } }],
    ]);
    const done = finished();
    await send(bot, "save a file");
    const reply = await done;
    expect(toolPart(reply)).toMatchObject({ name: "write_file", status: "done" });
    expect(reply.parts.at(-1)).toEqual({ type: "text", text: "Saved it." });
    expect(readFileSync(join(dataDir, "workspaces", bot.id, "hello.txt"), "utf8")).toBe("hi there");
    expect(requests[1].messages.at(-1)).toMatchObject({ role: "tool", tool_name: "write_file" });
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(
      expect.arrayContaining(["run_command", "read_file", "write_file", "ask_user"]),
    );
  });

  it("shows a terminal approval card, then runs the command when allowed", async () => {
    const { bot } = await setup([
      [toolCall("run_command", { command: "echo approved-run" })],
      [{ message: { content: "Ran it." } }],
    ]);
    const card = pendingApproval();
    const done = finished();
    await send(bot, "run it");
    const approval = await card;
    expect(approval).toMatchObject({ kind: "terminal", summary: "echo approved-run", canAlways: false });
    const res = await h!.app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}`,
      headers: auth,
      payload: { decision: "allow_once" },
    });
    expect(res.statusCode).toBe(204);
    const reply = await done;
    expect(toolPart(reply)).toMatchObject({
      status: "done",
      result: expect.stringContaining("approved-run"),
    });
    const again = await h!.app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}`,
      headers: auth,
      payload: { decision: "deny" },
    });
    expect(again.statusCode).toBe(410);
  });

  it("reports a denial to the model", async () => {
    const { bot, requests } = await setup([
      [toolCall("run_command", { command: "echo nope" })],
      [{ message: { content: "OK, skipped." } }],
    ]);
    const card = pendingApproval();
    const done = finished();
    await send(bot, "run it");
    await h!.app.inject({
      method: "POST",
      url: `/api/approvals/${(await card).id}`,
      headers: auth,
      payload: { decision: "deny" },
    });
    const reply = await done;
    expect(toolPart(reply)?.status).toBe("denied");
    expect(requests[1].messages.at(-1).content).toContain("denied");
  });

  it("never runs commands when local execution is set to never", async () => {
    const { bot } = await setup([
      [toolCall("run_command", { command: "echo x" })],
      [{ message: { content: "Can't." } }],
    ]);
    await h!.app.inject({
      method: "PUT",
      url: "/api/permissions",
      headers: auth,
      payload: { localExecution: "never", rules: [] },
    });
    const done = finished();
    await send(bot, "run it");
    expect(toolPart(await done)?.status).toBe("denied");
  });

  it("remembers 'Always allow' for general actions", async () => {
    const outside = join(tmpdir(), `mrog-outside-${Date.now()}.txt`);
    const { bot } = await setup([
      [toolCall("write_file", { path: outside, content: "1" })],
      [{ message: { content: "one" } }],
      [toolCall("write_file", { path: outside, content: "2" })],
      [{ message: { content: "two" } }],
    ]);
    const card = pendingApproval();
    let done = finished();
    await send(bot, "write outside");
    const approval = await card;
    expect(approval).toMatchObject({
      kind: "general",
      canAlways: true,
      badges: expect.arrayContaining(["Outside the bot's folder"]),
    });
    await h!.app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}`,
      headers: auth,
      payload: { decision: "always" },
    });
    await done;

    done = finished();
    await send(bot, "again");
    expect(toolPart(await done)?.status).toBe("done");
    expect(readFileSync(outside, "utf8")).toBe("2");
    const perms = (await h!.app.inject({ url: "/api/permissions", headers: auth })).json().permissions;
    // Only this same action is allowed from now on, not every write anywhere.
    expect(perms.rules).toMatchObject([{ tool: "write_file", decision: "allow", match: `Write ${outside}` }]);
    rmSync(outside, { force: true });
  });

  it("asks the user a question and continues with the answer", async () => {
    const { bot, requests } = await setup([
      [toolCall("ask_user", { question: "Which color?" })],
      [{ message: { content: "Green it is." } }],
    ]);
    const asked = nextEvent<string>(h!.bus, (e) => {
      if (e.type !== "message.updated") return undefined;
      const q = e.message.parts.find((p: MessagePart) => p.type === "question");
      return q?.type === "question" && !q.answer && q.questionId;
    });
    const done = finished();
    await send(bot, "pick a color");
    const questionId = await asked;
    await h!.app.inject({
      method: "POST",
      url: `/api/questions/${questionId}`,
      headers: auth,
      payload: { answer: "green" },
    });
    const reply = await done;
    expect(reply.parts.find((p) => p.type === "question")).toMatchObject({ answer: "green" });
    expect(requests[1].messages.at(-1).content).toBe("The user answered: green");
  });

  it("tells the model actions that need approval aren't available in group chats, instead of waiting", async () => {
    const { bot, requests } = await setup([
      [toolCall("run_command", { command: "echo x" })],
      [{ message: { content: "skipped" } }],
    ]);
    const thread = h!.store.threads.createGroup("Team", [bot.id]);
    h!.services.turns.extensions.responders = async () => [bot];
    const done = finished();
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: auth,
      payload: { text: "go" },
    });
    expect(toolPart(await done)?.result).toContain("Not available in group chats");
    expect(requests[1].messages.at(-1).content).not.toContain("denied");
    expect(existsSync(join(dataDir, "workspaces"))).toBe(false);
  });
});

describe("stopped turns", () => {
  it("doesn't show an approval or a question card once the turn is stopped", async () => {
    await setup([]);
    const { approvals, questions } = h!.services.agent;
    const parts: MessagePart[] = [
      { type: "tool", callId: "c1", name: "run_command", args: {}, status: "running" },
    ];
    let published = 0;
    h!.services.turns.partHooks.set("msg_x", { parts, publish: () => (published += 1) });
    const controller = new AbortController();
    controller.abort();
    const scope = {
      threadId: "thr_x",
      messageId: "msg_x",
      botId: "bot_x",
      groupChat: false,
      signal: controller.signal,
    };
    const request = {
      call: { id: "c1", name: "run_command", arguments: {} },
      risk: { level: "ask", kind: "general", badges: [], summary: "echo x" },
    } as unknown as ApprovalRequest;
    expect(await approvals.decide(request, scope)).toBe("deny");
    await expect(questions.ask("Which color?", scope)).rejects.toThrow("Stopped.");
    expect(parts).toEqual([{ type: "tool", callId: "c1", name: "run_command", args: {}, status: "running" }]);
    expect(published).toBe(0);
  });
});

describe("always allow", () => {
  it("isn't offered for site actions or logins, and never saves a rule for them", async () => {
    await setup([]);
    const { approvals } = h!.services.agent;
    const parts: MessagePart[] = [
      { type: "tool", callId: "c1", name: "browser_click", args: {}, status: "running" },
    ];
    h!.services.turns.partHooks.set("msg_x", { parts, publish: () => {} });
    const scope = {
      threadId: "thr_x",
      messageId: "msg_x",
      botId: "bot_x",
      groupChat: false,
      signal: new AbortController().signal,
    };
    const request = {
      call: { id: "c1", name: "browser_click", arguments: {} },
      risk: {
        level: "ask",
        kind: "general",
        badges: ["This may buy, send or change something on the site"],
        summary: "Click “Add to cart”",
      },
    } as unknown as ApprovalRequest;
    const decided = approvals.decide(request, scope);
    const part = parts[0] as Extract<MessagePart, { type: "tool" }>;
    expect(part.approval?.canAlways).toBe(false);
    expect(approvals.respond(part.approval!.id, "always")).toBe(true);
    expect(await decided).toBe("allow");
    expect(approvals.permissions().rules).toEqual([]);
  });
});

describe("stopped cards", () => {
  it("marks a question nobody answered as expired when the turn is stopped", async () => {
    const { bot } = await setup([[toolCall("ask_user", { question: "Which color?" })]]);
    const asked = nextEvent(h!.bus, (e) => e.type === "thread.activity" && e.activity === "waiting_user");
    const done = finished();
    await send(bot, "ask me");
    await asked;
    await h!.app.inject({ method: "POST", url: `/api/threads/${bot.threadId}/stop`, headers: auth });
    const reply = await done;
    expect(reply.parts.find((p) => p.type === "question")).toMatchObject({ expired: true });
  });
});

describe("how bots work", () => {
  it("keeps a plan from plain-string steps and tells the bot to plan and cite", async () => {
    const { bot, requests } = await setup([
      [toolCall("update_plan", { steps: ["Search", "Compare"] })],
      [{ message: { content: "Done." } }],
    ]);
    const done = finished();
    await send(bot, "compare two phones");
    const reply = await done;
    const plan = reply.parts.find((p) => p.type === "tool" && p.name === "update_plan");
    expect(plan).toMatchObject({ status: "done", result: expect.stringContaining("0 of 2 done") });
    const system = requests[0].messages[0].content as string;
    expect(system).toContain("first call update_plan");
    expect(system).toContain("say where each came from");
    expect(system).toMatch(/This computer runs/);
  });

  it("uses the step limit and self-check from settings", async () => {
    const loop = () => [toolCall("update_plan", { steps: ["x"] })];
    const { bot, requests } = await setup([loop(), loop(), loop(), loop(), loop(), loop(), loop()]);
    const saved = await h!.app.inject({
      method: "PUT",
      url: "/api/agent-settings",
      headers: auth,
      payload: { maxSteps: 5, selfCheck: false, planning: true },
    });
    expect(saved.statusCode).toBe(200);
    const done = finished();
    await send(bot, "loop");
    const reply = await done;
    expect(JSON.stringify(reply.parts)).toContain("Stopped after 5 steps");
    // Five steps plus the closing summary request.
    expect(requests).toHaveLength(6);
  });

  it("leaves the plan tool out when planning is off", async () => {
    const { bot, requests } = await setup([[{ message: { content: "Hi" } }]]);
    h!.services.agent.saveSettings({ maxSteps: 25, selfCheck: true, planning: false });
    const done = finished();
    await send(bot, "hello");
    await done;
    const names = (requests[0].tools ?? []).map((t: any) => t.function.name);
    expect(names).not.toContain("update_plan");
    expect(requests[0].messages[0].content).not.toContain("update_plan");
  });
});
