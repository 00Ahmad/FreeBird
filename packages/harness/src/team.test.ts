import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, messageText, type Bot, type Message, type Thread } from "@mrog/shared";
import { BUILTIN_SKILLS } from "@mrog/skills";

import { mentionedBots } from "./team";
import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

/** The skills FreeBird ships with, shared by every bot. */
const BUILTIN_NAMES = new Set(BUILTIN_SKILLS.map((skill) => skill.name));

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Each chat call answers with "<system prompt's bot name>: <n>" unless a script says otherwise. */
function setupOllama(script: ((body: any) => unknown[] | undefined)[] = []) {
  const requests: any[] = [];
  const handlers = fakeOllama((body) => {
    requests.push(body);
    const custom = script.shift()?.(body);
    if (custom) return ndjson([...custom, { done: true }]);
    const name = /You are ([^,:]+)/.exec(body.messages[0]?.content ?? "")?.[1] ?? "?";
    return ndjson([{ message: { content: `${name} here` } }, { done: true }]);
  });
  return { requests, handlers };
}

async function start(script?: ((body: any) => unknown[] | undefined)[], dataDir?: string) {
  const ollama = setupOllama(script);
  h = await makeHarness({ handlers: ollama.handlers, config: dataDir ? { dataDir } : {} });
  h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
  const make = async (name: string) =>
    (await h!.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name } })).json()
      .bot as Bot;
  return { requests: ollama.requests, make };
}

const doneMessages = (count: number) =>
  new Promise<Message[]>((resolve) => {
    const out: Message[] = [];
    h!.bus.subscribe((e) => {
      if (e.type === "message.updated" && e.message.role === "bot" && e.message.status === "done") {
        out.push(e.message);
        if (out.length === count) resolve(out);
      }
    });
  });

describe("mentions", () => {
  const bot = (name: string) => ({ name }) as Bot;
  it("finds @names with spaces, ignores partial words, and sees @everyone", () => {
    const team = [bot("Ada"), bot("Inbox Triage"), bot("Adam")];
    expect(mentionedBots("hey @ada and @inbox triage", team)).toEqual([bot("Ada"), bot("Inbox Triage")]);
    expect(mentionedBots("@Adam only", team)).toEqual([bot("Adam")]);
    expect(mentionedBots("@everyone stand up", team)).toBe("everyone");
    expect(mentionedBots("no mentions", team)).toEqual([]);
  });

  it("finds a name however many times a longer one comes first, and never inside an address", () => {
    const team = [bot("Ada"), bot("Adam")];
    expect(mentionedBots("@adam and @ada", team)).toEqual([bot("Ada"), bot("Adam")]);
    expect(mentionedBots("mail ops@ada.example", team)).toEqual([]);
  });
});

describe("group chats", () => {
  it("creates a group, routes @mentions, and answers one bot after another", async () => {
    const { make } = await start();
    const ada = await make("Ada");
    const bea = await make("Bea");
    const res = await h!.app.inject({
      method: "POST",
      url: "/api/threads",
      headers: auth,
      payload: { title: "Launch", memberIds: [ada.id, bea.id] },
    });
    expect(res.statusCode).toBe(201);
    const thread = res.json().thread as Thread;

    const two = doneMessages(2);
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: auth,
      payload: { text: "@everyone status?" },
    });
    const replies = await two;
    expect(replies.map(messageText)).toEqual(["Ada here", "Bea here"]);

    const one = doneMessages(1);
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: auth,
      payload: { text: "@Bea just you" },
    });
    expect(messageText((await one)[0]!)).toBe("Bea here");
  });

  it("asks the shared model who should answer when nobody is mentioned", async () => {
    const { make, requests } = await start([() => [{ message: { content: "Bea" } }]]);
    const ada = await make("Ada");
    const bea = await make("Bea");
    const thread = (
      await h!.app.inject({
        method: "POST",
        url: "/api/threads",
        headers: auth,
        payload: { memberIds: [ada.id, bea.id] },
      })
    ).json().thread as Thread;
    const one = doneMessages(1);
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: auth,
      payload: { text: "who handles design?" },
    });
    expect((await one)[0]?.botId).toBe(bea.id);
    expect(requests[0].messages.at(-1).content).toContain("Which one or two members should answer?");
  });

  it("picks bots by whole name from the routing reply, asked as a routing question", async () => {
    const { make, requests } = await start([() => [{ message: { content: "Adam" } }]]);
    const ada = await make("Ada");
    const adam = await make("Adam");
    const thread = h!.store.threads.createGroup(null, [ada.id, adam.id]);
    const one = doneMessages(1);
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: auth,
      payload: { text: "who's free?" },
    });
    expect((await one)[0]?.botId).toBe(adam.id);
    expect(requests[0].messages[0].content).toContain("You pick who answers in a group chat");
    expect(requests[0].messages[0].content).not.toContain("Summarize");
  });

  it("falls back to the primary bot when the routing reply names nobody", async () => {
    const { make } = await start([() => [{ message: { content: "Nobody, sorry." } }]]);
    const ada = await make("Ada");
    const bea = await make("Bea");
    await h!.app.inject({
      method: "PATCH",
      url: `/api/bots/${bea.id}`,
      headers: auth,
      payload: { isPrimary: true },
    });
    const thread = h!.store.threads.createGroup(null, [ada.id, bea.id]);
    const one = doneMessages(1);
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: auth,
      payload: { text: "hello?" },
    });
    expect((await one)[0]?.botId).toBe(bea.id);
  });

  it("ends a group's round of answers at Stop", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const asked: string[] = [];
    h = await makeHarness({
      handlers: fakeOllama(async (body) => {
        const name = /You are ([^,:]+)/.exec(body.messages[0]?.content ?? "")?.[1] ?? "?";
        asked.push(name);
        // Ada's reply is held until Stop has been pressed.
        if (name === "Ada") await gate;
        return ndjson([{ message: { content: `${name} here` } }, { done: true }]);
      }),
    });
    h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    const ada = h.store.bots.create({ name: "Ada" });
    const bea = h.store.bots.create({ name: "Bea" });
    const thread = h.store.threads.createGroup(null, [ada.id, bea.id]);
    h.services.turns.extensions.responders = async () => [ada, bea];
    const adaStarted = nextEvent(h.bus, (e) => e.type === "message.created" && e.message.botId === ada.id);
    const adaDone = nextEvent<Message>(
      h!.bus,
      (e) =>
        e.type === "message.updated" &&
        e.message.botId === ada.id &&
        e.message.status !== "streaming" &&
        e.message,
    );
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: auth,
      payload: { text: "both of you" },
    });
    await adaStarted;
    await h!.app.inject({ method: "POST", url: `/api/threads/${thread.id}/stop`, headers: auth });
    release();
    await adaDone;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h!.services.turns.isBusy(thread.id)).toBe(false);
    expect(asked).not.toContain("Bea");
  });

  it("answers the POST at once while picking responders waits for the shared model", async () => {
    const { make } = await start([() => [{ message: { content: "Bea" } }]]);
    const ada = await make("Ada");
    const bea = await make("Bea");
    const thread = h!.store.threads.createGroup(null, [ada.id, bea.id]);
    // Something else (say a direct chat waiting on an approval) holds the only shared-model slot.
    let free!: () => void;
    const held = h!.services.runtime.run("user", () => new Promise<void>((resolve) => (free = resolve)));
    const sent = await h!.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: auth,
      payload: { text: "who handles design?" },
    });
    expect(sent.statusCode).toBe(201);
    expect(messageText(sent.json().message)).toBe("who handles design?");

    const one = doneMessages(1);
    free();
    await held;
    expect((await one)[0]?.botId).toBe(bea.id);
  });

  it("rejects unknown or repeated members instead of failing", async () => {
    const { make } = await start();
    const ada = await make("Ada");
    const bea = await make("Bea");
    const unknown = `bot_${"0".repeat(32)}`;
    const create = (memberIds: string[]) =>
      h!.app.inject({ method: "POST", url: "/api/threads", headers: auth, payload: { memberIds } });
    expect((await create([ada.id, ada.id])).statusCode).toBe(400);
    expect((await create([ada.id, unknown])).statusCode).toBe(400);
    expect(h!.store.threads.list().filter((t) => t.kind === "group")).toEqual([]);

    const thread = (await create([ada.id, bea.id])).json().thread as Thread;
    const patch = (memberIds: string[]) =>
      h!.app.inject({
        method: "PATCH",
        url: `/api/threads/${thread.id}`,
        headers: auth,
        payload: { memberIds },
      });
    expect((await patch([ada.id, unknown])).json()).toMatchObject({ error: "invalid_request" });
    expect((await patch([bea.id, bea.id])).statusCode).toBe(400);
    expect(h!.store.threads.get(thread.id)?.memberIds).toEqual([ada.id, bea.id]);
    expect((await patch([bea.id, ada.id, bea.id])).json().thread.memberIds).toEqual([bea.id, ada.id]);
  });

  it("validates group size and renames or deletes groups", async () => {
    const { make } = await start();
    const ada = await make("Ada");
    const tooFew = await h!.app.inject({
      method: "POST",
      url: "/api/threads",
      headers: auth,
      payload: { memberIds: [ada.id] },
    });
    expect(tooFew.statusCode).toBe(400);
    const bea = await make("Bea");
    const thread = (
      await h!.app.inject({
        method: "POST",
        url: "/api/threads",
        headers: auth,
        payload: { memberIds: [ada.id, bea.id] },
      })
    ).json().thread;
    const renamed = await h!.app.inject({
      method: "PATCH",
      url: `/api/threads/${thread.id}`,
      headers: auth,
      payload: { title: "Ops" },
    });
    expect(renamed.json().thread.title).toBe("Ops");
    expect(
      (await h!.app.inject({ method: "DELETE", url: `/api/threads/${thread.id}`, headers: auth })).statusCode,
    ).toBe(204);
    const direct = await h!.app.inject({
      method: "DELETE",
      url: `/api/threads/${ada.threadId}`,
      headers: auth,
    });
    expect(direct.statusCode).toBe(400);
  });
});

describe("memory", () => {
  it("saves notes through the remember tool and puts them in every prompt", async () => {
    const { make, requests } = await start([
      () => [
        {
          message: {
            tool_calls: [
              { function: { name: "remember", arguments: { note: "User prefers metric units" } } },
            ],
          },
        },
      ],
    ]);
    const ada = await make("Ada");
    const first = doneMessages(1);
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${ada.threadId}/messages`,
      headers: auth,
      payload: { text: "I use metric" },
    });
    await first;
    const notes = (await h!.app.inject({ url: `/api/bots/${ada.id}/memory`, headers: auth })).json().notes;
    expect(notes.map((n: any) => n.text)).toEqual(["User prefers metric units"]);

    const second = doneMessages(1);
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${ada.threadId}/messages`,
      headers: auth,
      payload: { text: "again" },
    });
    await second;
    expect(requests.at(-1).messages[0].content).toContain("- User prefers metric units");
  });

  it("doesn't save a note twice, and won't forget on a word as short as 'the'", async () => {
    const call = (name: string, args: unknown) => () => [
      { message: { tool_calls: [{ function: { name, arguments: args } }] } },
    ];
    const { make } = await start([
      call("remember", { note: "the user likes short answers." }),
      call("forget", { text: "the" }),
      call("forget", { text: "short answers" }),
    ]);
    const ada = await make("Ada");
    h!.store.memory.add(ada.id, "The user likes short answers");
    h!.store.memory.add(ada.id, "Works in the Leeds office");
    const finished = doneMessages(1);
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${ada.threadId}/messages`,
      headers: auth,
      payload: { text: "remember that and tidy up" },
    });
    const [reply] = await finished;
    const results = reply!.parts.flatMap((part) => (part.type === "tool" ? [part.result] : []));
    expect(results[0]).toContain("Already in memory");
    expect(results[1]).toContain("at least one word of 4 letters");
    expect(results[2]).toBe("Forgot 1 note(s).");
    expect(h!.store.memory.list(ada.id).map((note) => note.text)).toEqual(["Works in the Leeds office"]);
  });

  it("lets the user pin notes the bot can't forget, up to a limit", async () => {
    const call = (name: string, args: unknown) => () => [
      { message: { tool_calls: [{ function: { name, arguments: args } }] } },
    ];
    const { make, requests } = await start([call("forget", { text: "Leeds" })]);
    const ada = await make("Ada");
    const office = h!.store.memory.add(ada.id, "Works in the Leeds office");
    h!.store.memory.add(ada.id, "Likes Leeds United");
    const pin = (id: string, pinned: boolean) =>
      h!.app.inject({ method: "PATCH", url: `/api/memory/${id}`, headers: auth, payload: { pinned } });
    expect((await pin(office.id, true)).json().note).toMatchObject({ pinned: true, text: office.text });

    const finished = doneMessages(1);
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${ada.threadId}/messages`,
      headers: auth,
      payload: { text: "forget Leeds" },
    });
    const [reply] = await finished;
    const result = reply!.parts.find((part) => part.type === "tool")!;
    expect(result.type === "tool" && result.result).toMatch(
      /Forgot 1 note\(s\)\. 1 pinned note\(s\) matched too/,
    );
    expect(h!.store.memory.list(ada.id).map((note) => note.text)).toEqual(["Works in the Leeds office"]);
    expect(requests[0].messages[0].content).toContain("- Works in the Leeds office");

    const listed = (await h!.app.inject({ url: `/api/bots/${ada.id}/memory`, headers: auth })).json();
    expect(listed).toMatchObject({ notSent: 0, sentIds: [office.id], pinnedOver: false });

    for (let i = 0; i < 9; i++) await pin(h!.store.memory.add(ada.id, `Note ${i}`).id, true);
    const eleventh = await pin(h!.store.memory.add(ada.id, "One too many").id, true);
    expect(eleventh.statusCode).toBe(409);
    expect(eleventh.json().message).toMatch(/At most 10 notes can be pinned/);
  });

  it("lets the user add, edit, import and delete notes", async () => {
    const { make } = await start();
    const ada = await make("Ada");
    const added = (
      await h!.app.inject({
        method: "POST",
        url: `/api/bots/${ada.id}/memory`,
        headers: auth,
        payload: { text: "Likes tea" },
      })
    ).json().note;
    await h!.app.inject({
      method: "PATCH",
      url: `/api/memory/${added.id}`,
      headers: auth,
      payload: { text: "Likes green tea" },
    });
    const imported = await h!.app.inject({
      method: "POST",
      url: `/api/bots/${ada.id}/memory/import`,
      headers: auth,
      payload: { text: "- Works at Acme\n- Timezone is CET\n\nPrefers short answers" },
    });
    expect(imported.json()).toEqual({ added: 3 });
    const notes = (await h!.app.inject({ url: `/api/bots/${ada.id}/memory`, headers: auth }))
      .json()
      .notes.map((n: any) => n.text);
    expect(notes).toEqual(["Likes green tea", "Works at Acme", "Timezone is CET", "Prefers short answers"]);
    expect(
      (await h!.app.inject({ method: "DELETE", url: `/api/memory/${added.id}`, headers: auth })).statusCode,
    ).toBe(204);
  });
});

describe("skills, reactions, duplicate", () => {
  it("manages skills per bot and shared", async () => {
    const { make } = await start();
    const ada = await make("Ada");
    const bea = await make("Bea");
    await h!.app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth,
      payload: { botId: null, name: "standup", prompt: "Write my standup." },
    });
    await h!.app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth,
      payload: { botId: ada.id, name: "triage", prompt: "Triage my inbox." },
    });
    const forAda = (await h!.app.inject({ url: `/api/skills?botId=${ada.id}`, headers: auth }))
      .json()
      .skills.filter((s: any) => !BUILTIN_NAMES.has(s.name))
      .map((s: any) => s.name);
    const forBea = (await h!.app.inject({ url: `/api/skills?botId=${bea.id}`, headers: auth }))
      .json()
      .skills.filter((s: any) => !BUILTIN_NAMES.has(s.name))
      .map((s: any) => s.name);
    expect(forAda).toEqual(["standup", "triage"]);
    expect(forBea).toEqual(["standup"]);
    const bad = await h!.app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth,
      payload: { botId: null, name: "bad name!", prompt: "x" },
    });
    expect(bad.statusCode).toBe(400);
    const unknownBot = await h!.app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth,
      payload: { botId: `bot_${"0".repeat(32)}`, name: "orphan", prompt: "x" },
    });
    expect(unknownBot.statusCode).toBe(400);
  });

  it("toggles reactions and duplicates a bot without its history", async () => {
    const { make } = await start();
    const ada = await make("Ada");
    await h!.app.inject({
      method: "PATCH",
      url: `/api/bots/${ada.id}`,
      headers: auth,
      payload: { instructions: "Be brief." },
    });
    await h!.app.inject({
      method: "POST",
      url: "/api/skills",
      headers: auth,
      payload: { botId: ada.id, name: "triage", prompt: "Triage." },
    });
    const done = doneMessages(1);
    const sent = (
      await h!.app.inject({
        method: "POST",
        url: `/api/threads/${ada.threadId}/messages`,
        headers: auth,
        payload: { text: "hi" },
      })
    ).json().message;
    await done;
    const on = await h!.app.inject({
      method: "POST",
      url: `/api/messages/${sent.id}/reactions`,
      headers: auth,
      payload: { emoji: "👍" },
    });
    expect(on.json().message.reactions).toEqual(["👍"]);
    const off = await h!.app.inject({
      method: "POST",
      url: `/api/messages/${sent.id}/reactions`,
      headers: auth,
      payload: { emoji: "👍" },
    });
    expect(off.json().message.reactions).toEqual([]);

    const copy = (
      await h!.app.inject({ method: "POST", url: `/api/bots/${ada.id}/duplicate`, headers: auth })
    ).json().bot as Bot;
    expect(copy).toMatchObject({ name: "Ada copy", instructions: "Be brief.", avatar: ada.avatar });
    expect(copy.threadId).not.toBe(ada.threadId);
    expect(
      (await h!.app.inject({ url: `/api/threads/${copy.threadId}/messages`, headers: auth })).json().messages,
    ).toEqual([]);
    expect(
      (await h!.app.inject({ url: `/api/skills?botId=${copy.id}`, headers: auth }))
        .json()
        .skills.filter((s: any) => !BUILTIN_NAMES.has(s.name))
        .map((s: any) => s.name),
    ).toEqual(["triage"]);
  });
});

describe("bot files", () => {
  it("lists files and skips entries it can't read, like a broken link", async (ctx) => {
    const dataDir = mkdtempSync(join(tmpdir(), "mrog-files-"));
    try {
      const { make } = await start([], dataDir);
      const ada = await make("Ada");
      const root = h!.services.agent.workspaceFor(ada.id);
      mkdirSync(join(root, "notes"), { recursive: true });
      writeFileSync(join(root, "notes", "todo.txt"), "milk");
      try {
        symlinkSync(join(root, "gone.txt"), join(root, "broken.txt"), "file");
      } catch {
        // Windows without Developer Mode can't make symlinks, but can make a junction.
        try {
          symlinkSync(join(root, "gone"), join(root, "broken"), "junction");
        } catch {
          ctx.skip();
        }
      }
      const res = await h!.app.inject({ url: `/api/bots/${ada.id}/files`, headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json().files.map((f: { path: string }) => f.path)).toEqual(["notes/todo.txt"]);
    } finally {
      await h?.close();
      h = undefined;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("bot-to-bot", () => {
  it("lets one bot message another and use the reply, in a thread the user can read", async () => {
    const { make, requests } = await start([
      () => [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "message_bot",
                  arguments: { bot_name: "Bea", message: "What's the deadline?" },
                },
              },
            ],
          },
        },
      ],
      () => [{ message: { content: "Friday." } }],
      () => [{ message: { content: "Bea says Friday." } }],
    ]);
    const ada = await make("Ada");
    const bea = await make("Bea");
    // The user's own group of the same two bots is not where they talk to each other.
    const group = h!.store.threads.createGroup("Us two", [ada.id, bea.id]);
    const final = nextEvent<Message>(
      h!.bus,
      (e) =>
        e.type === "message.updated" &&
        e.message.botId === ada.id &&
        e.message.status === "done" &&
        e.message,
      8000,
    );
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${ada.threadId}/messages`,
      headers: auth,
      payload: { text: "ask Bea" },
    });
    const reply = await final;
    expect(messageText(reply)).toBe("Bea says Friday.");
    expect(requests[2].messages.at(-1).content).toBe("Bea replied: Friday.");

    const pair = h!.store.threads.list().find((t) => t.pair)!;
    expect(pair).toMatchObject({ title: "Ada ↔ Bea", memberIds: expect.arrayContaining([ada.id, bea.id]) });
    expect(h!.store.messages.list(group.id)).toEqual([]);
    const texts = (await h!.app.inject({ url: `/api/threads/${pair.id}/messages`, headers: auth }))
      .json()
      .messages.map(messageText);
    expect(texts).toEqual(["What's the deadline?", "Friday."]);
  });

  it("deletes a deleted bot's bot-to-bot threads and tells the UI about the groups it left", async () => {
    const { make } = await start();
    const ada = await make("Ada");
    const bea = await make("Bea");
    const cy = await make("Cy");
    const pair = h!.store.threads.createGroup("Ada ↔ Bea", [ada.id, bea.id], { pair: true });
    const trio = h!.store.threads.createGroup("Trio", [ada.id, bea.id, cy.id]);
    const duo = h!.store.threads.createGroup("Duo", [ada.id, bea.id]);
    const events: string[] = [];
    h!.bus.subscribe((e) => {
      if (e.type === "thread.deleted") events.push(`deleted ${e.threadId}`);
      if (e.type === "thread.updated") events.push(`updated ${e.thread.id} ${e.thread.memberIds.length}`);
    });
    await h!.app.inject({ method: "DELETE", url: `/api/bots/${bea.id}`, headers: auth });
    expect(h!.store.threads.get(pair.id)).toBeNull();
    expect(events).toEqual(
      expect.arrayContaining([`deleted ${pair.id}`, `updated ${trio.id} 2`, `updated ${duo.id} 1`]),
    );
    // A group the user made keeps its history, and isn't mistaken for a pair later.
    expect(h!.store.threads.get(trio.id)).toMatchObject({ pair: false, memberIds: [ada.id, cy.id] });
  });

  it("leaves helper creation out of a coordinator's tools in group chats", async () => {
    const { make, requests } = await start();
    const boss = await make("Boss");
    await h!.app.inject({
      method: "PATCH",
      url: `/api/bots/${boss.id}`,
      headers: auth,
      payload: { isPrimary: true },
    });
    const mate = await make("Mate");
    const thread = h!.store.threads.createGroup("Team", [boss.id, mate.id]);
    const one = doneMessages(1);
    await h!.app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: auth,
      payload: { text: "@Boss plan it" },
    });
    await one;
    const tools = (requests.at(-1).tools ?? []).map((t: any) => t.function.name);
    expect(tools).toContain("delegate");
    expect(tools).not.toContain("spawn_bot");
    expect(requests.at(-1).messages[0].content).not.toContain("spawn_bot");
  });
});
