import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_SETTINGS, type Bot, type Message } from "@mrog/shared";

import { answerQuery, KEEP_OVER, queryPath, ResultStore, shapeOf, summary } from "./results";
import { auth, fakeOllama, makeHarness, ndjson, nextEvent, type TestHarness } from "./testing";

const mail = {
  query: "invoice",
  total: 3,
  messages: [
    { id: "m0", from: "boss@example.com", subject: "Invoice due", unread: true, tags: ["work"] },
    { id: "m1", from: "pat@example.com", subject: "Lunch?", unread: false, tags: [] },
    { id: "m2", from: "boss@example.com", subject: "Re: invoice", unread: false, tags: ["work", "money"] },
  ],
  next: null,
};

describe("reading part of a result by path", () => {
  it("follows keys, indexes and slices", () => {
    expect(queryPath(mail, "total")).toBe(3);
    expect(queryPath(mail, "messages[1].subject")).toBe("Lunch?");
    expect(queryPath(mail, "messages[-1].id")).toBe("m2");
    expect(queryPath(mail, "messages[0:2]")).toHaveLength(2);
    expect(queryPath(mail, "$.query")).toBe("invoice");
  });

  it("applies what follows [*], a slice or a filter to each item", () => {
    expect(queryPath(mail, "messages[*].id")).toEqual(["m0", "m1", "m2"]);
    expect(queryPath(mail, "messages[1:].from")).toEqual(["pat@example.com", "boss@example.com"]);
    expect(queryPath(mail, "messages[*].tags[0]")).toEqual(["work", "work"]);
  });

  it("filters by equality, inequality and contained text", () => {
    expect(queryPath(mail, "messages[?unread==true].id")).toEqual(["m0"]);
    expect(queryPath(mail, "messages[?from==boss@example.com].id")).toEqual(["m0", "m2"]);
    expect(queryPath(mail, "messages[?from!='boss@example.com'].subject")).toEqual(["Lunch?"]);
    expect(queryPath(mail, "messages[?subject~INVOICE].id")).toEqual(["m0", "m2"]);
  });

  it("says plainly what it can't read, and can't run anything", () => {
    expect(() => queryPath(mail, "messages[(function(){})()]")).toThrow(/can't read the path/);
    expect(() => queryPath(mail, "messages|length")).toThrow(/can't read the path/);
    expect(queryPath(mail, "nope.deeper")).toBeUndefined();
  });
});

describe("describing a result", () => {
  it("gives keys, list lengths and the first item's shape", () => {
    const shape = shapeOf(mail);
    expect(shape).toContain('query: "invoice"');
    expect(shape).toContain("messages: [3 items: {id, from, subject, unread, tags: [1 item: ");
  });

  it("summarizes a big JSON result as valid previews, never half a document", () => {
    const big = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, body: "x".repeat(300) })) };
    const text = JSON.stringify(big);
    expect(text.length).toBeGreaterThan(KEEP_OVER);
    const shown = summary("r1", "Mail → search", { text, json: big });
    expect(shown).toContain('kept as "r1"');
    expect(shown).toContain("items: [200 items:");
    const preview = /A preview \(lists cut to their first items\): (.*)$/m.exec(shown)![1]!;
    expect(() => JSON.parse(preview)).not.toThrow();
    expect(shown.length).toBeLessThan(3_000);
  });

  it("answers a query, capped, and suggests a narrower one when it is still too big", () => {
    const big = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, body: "y".repeat(100) })) };
    const kept = { text: JSON.stringify(big), json: big };
    expect(answerQuery(kept, { path: "items[0:2].id" })).toBe("[0,1]");
    const wide = answerQuery(kept, { path: "items" });
    expect(wide.length).toBeLessThan(7_000);
    expect(wide).toMatch(/narrower path/);
    expect(answerQuery(kept, { path: "missing" })).toMatch(/Nothing at "missing"/);
  });

  it("reads plain text by lines and by search", () => {
    const text = Array.from(
      { length: 500 },
      (_, i) => `line ${i + 1}${i === 249 ? " needle here" : ""}`,
    ).join("\n");
    const kept = { text, json: undefined };
    expect(answerQuery(kept, { lines: "10-12" })).toBe("Lines 10-12 of 500:\nline 10\nline 11\nline 12");
    expect(answerQuery(kept, { find: "NEEDLE" })).toBe('1 line contain "NEEDLE":\n250: line 250 needle here');
    expect(answerQuery(kept, { path: "a.b" })).toMatch(/isn't JSON/);
  });
});

describe("keeping results", () => {
  it("keeps them per bot and chat, so one bot can't read another's", () => {
    const store = new ResultStore();
    const id = store.put("bot_a", "thr_1", "Mail → search", "hello");
    expect(store.get("bot_a", "thr_1", id)?.text).toBe("hello");
    expect(store.get("bot_b", "thr_1", id)).toBeNull();
    expect(store.get("bot_a", "thr_2", id)).toBeNull();
    expect(store.put("bot_a", "thr_1", "x", "again")).toBe("r2");
    expect(store.put("bot_a", "thr_2", "x", "elsewhere")).toBe("r1");
  });

  it("lets the oldest go when there are too many or they are too big, and keeps one being read", () => {
    const store = new ResultStore(3, 1_000_000);
    const first = store.put("b", "t", "a", "1");
    const second = store.put("b", "t", "b", "2");
    store.get("b", "t", first); // read: now the newest
    store.put("b", "t", "c", "3");
    store.put("b", "t", "d", "4");
    expect(store.get("b", "t", second)).toBeNull();
    expect(store.get("b", "t", first)).not.toBeNull();

    const small = new ResultStore(100, 10);
    small.put("b", "t", "a", "123456");
    small.put("b", "t", "b", "7890ab");
    expect(small.list("b", "t").map((entry) => entry.label)).toEqual(["b"]);
  });

  it("forgets a chat's results when it is cleared or deleted, and a bot's when it is deleted", () => {
    const store = new ResultStore();
    store.put("b", "t1", "a", "x");
    store.put("b", "t2", "b", "y");
    store.put("c", "t1", "c", "z");
    store.dropThread("t1");
    expect(store.list("b", "t1")).toEqual([]);
    expect(store.list("c", "t1")).toEqual([]);
    expect(store.list("b", "t2")).toHaveLength(1);
    store.dropBot("b");
    expect(store.list("b", "t2")).toEqual([]);
  });
});

describe("a big result from a connected app, in a conversation", () => {
  let h: TestHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });
  const fixture = fileURLToPath(new URL("./fixtures/mail-mcp.mjs", import.meta.url));

  it("is shown as its shape, kept, read back with query_result, and scrubbed of secrets", async () => {
    const requests: any[] = [];
    const replies: unknown[][] = [
      [
        {
          message: {
            tool_calls: [{ function: { name: "mail__search_messages", arguments: { query: "invoice" } } }],
          },
        },
      ],
      [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "query_result",
                  arguments: { id: "r1", path: "messages[?unread==true].subject" },
                },
              },
            ],
          },
        },
      ],
      [{ message: { tool_calls: [{ function: { name: "mail__whoami", arguments: {} } }] } }],
      [{ message: { content: "Done." } }],
    ];
    h = await makeHarness({
      handlers: fakeOllama((body) => {
        requests.push(body);
        return ndjson([...(replies.shift() ?? [{ message: { content: "ok" } }]), { done: true }]);
      }),
    });
    h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
    h.services.vault.set("MAIL_TOKEN", "mail-token-0123456789");
    h.services.scrubber.refresh();
    await h.app.inject({
      method: "POST",
      url: "/api/connectors",
      headers: auth,
      payload: {
        name: "Mail",
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [fixture],
          env: { MAIL_TOKEN: "vault:MAIL_TOKEN" },
        },
        askBeforeUse: false,
      },
    });
    const bot = (
      await h.app.inject({ method: "POST", url: "/api/bots", headers: auth, payload: { name: "Ada" } })
    ).json().bot as Bot;
    const done = nextEvent<Message>(
      h.bus,
      (e) => e.type === "message.updated" && e.message.status === "done" && e.message,
      15000,
    );
    await h.app.inject({
      method: "POST",
      url: `/api/threads/${bot.threadId}/messages`,
      headers: auth,
      payload: { text: "find invoices" },
    });
    await done;

    // The model never saw the 60,000 characters, only the shape...
    const searchResult = requests[1].messages.at(-1).content as string;
    expect(searchResult).toContain('kept as "r1"');
    expect(searchResult).toContain("messages: [120 items:");
    expect(searchResult.length).toBeLessThan(3_500);
    // ...then read what it needed.
    const queried = JSON.parse(requests[2].messages.at(-1).content as string);
    expect(queried).toHaveLength(30);
    expect(queried[0]).toBe("Subject number 0 about invoice");
    // And what the app returns is scrubbed before anyone sees it.
    expect(requests[3].messages.at(-1).content).toBe("token in use: [hidden]");
    expect(JSON.stringify(requests)).not.toContain("mail-token-0123456789");

    // Clear chat forgets the kept result.
    await h.app.inject({ method: "DELETE", url: `/api/threads/${bot.threadId}/messages`, headers: auth });
    expect(h.services.connectors.results.list(bot.id, bot.threadId)).toEqual([]);
  }, 30_000);
});
