import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MIGRATIONS, migrate, openDatabase, openStore, type Store } from ".";

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

describe("migrations", () => {
  it("applies once and is a no-op the second time", () => {
    store = openStore(":memory:");
    expect(migrate(store.db)).toEqual([]);
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["bots", "threads", "messages", "routines", "settings"]));
    expect(tables).not.toContain("events");
    const columns = store.db
      .prepare("SELECT name FROM pragma_table_info('messages')")
      .all()
      .map((row) => row.name);
    expect(columns).not.toContain("content");
    const indexes = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'thread_members'")
      .all()
      .map((row) => row.name);
    expect(indexes).toContain("thread_members_by_bot");
  });

  it("marks bot-to-bot threads made before the pair flag, and keeps their messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "mrog-store-"));
    const path = join(dir, "app.db");
    try {
      const old = openDatabase(
        path,
        MIGRATIONS.filter((migration) => migration.id <= 9),
      );
      const now = new Date().toISOString();
      const [a, b, c] = ["a", "b", "c"].map((ch) => `bot_${ch.repeat(32)}`) as [string, string, string];
      for (const id of [a, b, c]) {
        old
          .prepare(
            "INSERT INTO bots (id, name, avatar_shape, avatar_color, created_at, updated_at) VALUES (?, ?, 'leaf', 'lime', ?, ?)",
          )
          .run(id, id, now, now);
      }
      const group = (n: string, title: string, members: string[]) => {
        const id = `thr_${n.repeat(32)}`;
        old
          .prepare(
            "INSERT INTO threads (id, kind, title, created_at, updated_at) VALUES (?, 'group', ?, ?, ?)",
          )
          .run(id, title, now, now);
        for (const member of members)
          old.prepare("INSERT INTO thread_members (thread_id, bot_id) VALUES (?, ?)").run(id, member);
        return id;
      };
      const pair = group("1", "Ada ↔ Bea", [a, b]);
      group("2", "Launch", [a, b]);
      group("3", "Ada ↔ Bea ↔ Cy", [a, b, c]);
      old
        .prepare(
          "INSERT INTO messages (id, thread_id, role, bot_id, content, parts, created_at) VALUES (?, ?, 'bot', ?, 'hi', ?, ?)",
        )
        .run(`msg_${"1".repeat(32)}`, pair, a, JSON.stringify([{ type: "text", text: "hi" }]), now);
      old.close();

      store = openStore(path);
      expect(
        store.threads
          .list()
          .filter((thread) => thread.pair)
          .map((thread) => thread.id),
      ).toEqual([pair]);
      expect(store.messages.list(pair).map((message) => message.parts)).toEqual([
        [{ type: "text", text: "hi" }],
      ]);
    } finally {
      store?.close();
      store = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists to disk across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "mrog-store-"));
    const path = join(dir, "nested", "app.db");
    try {
      const first = openStore(path);
      first.bots.create({ name: "Inbox" });
      first.close();
      const second = openStore(path);
      expect(second.bots.list().map((b) => b.name)).toEqual(["Inbox"]);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bots", () => {
  it("creates, updates and deletes", () => {
    store = openStore(":memory:");
    const bot = store.bots.create({ name: "Inbox", avatar: { shape: "leaf", color: "lime" } });
    expect(bot).toMatchObject({ name: "Inbox", label: null, isPrimary: false, avatar: { shape: "leaf" } });

    const updated = store.bots.update(bot.id, { label: "Email triage", pinned: true });
    expect(updated).toMatchObject({ label: "Email triage", pinned: true, name: "Inbox" });

    expect(store.bots.update("bot_" + "0".repeat(32), { pinned: true })).toBeNull();
    expect(store.bots.delete(bot.id)).toBe(true);
    expect(store.bots.delete(bot.id)).toBe(false);
  });

  describe("tool lists", () => {
    it("gives a bot made before the column existed no restriction, and keeps the row untouched", () => {
      const dir = mkdtempSync(join(tmpdir(), "mrog-store-"));
      const path = join(dir, "app.db");
      try {
        const old = openDatabase(
          path,
          MIGRATIONS.filter((migration) => migration.id <= 12),
        );
        const now = new Date().toISOString();
        const id = `bot_${"a".repeat(32)}`;
        old
          .prepare(
            "INSERT INTO bots (id, name, avatar_shape, avatar_color, created_at, updated_at) VALUES (?, 'Ada', 'leaf', 'lime', ?, ?)",
          )
          .run(id, now, now);
        old
          .prepare("INSERT INTO threads (id, kind, created_at, updated_at) VALUES (?, 'direct', ?, ?)")
          .run(`thr_${"1".repeat(32)}`, now, now);
        old
          .prepare("INSERT INTO thread_members (thread_id, bot_id) VALUES (?, ?)")
          .run(`thr_${"1".repeat(32)}`, id);
        old.close();

        store = openStore(path);
        expect(store.bots.get(id)?.tools).toEqual({ allow: null, exclude: [], apps: {} });
        const column = store.db
          .prepare("SELECT name FROM pragma_table_info('bots') WHERE name = 'tools'")
          .all();
        expect(column).toHaveLength(1);
      } finally {
        store?.close();
        store = undefined;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("saves, changes and clears a list, and stores nothing when there is nothing to restrict", () => {
      store = openStore(":memory:");
      const bot = store.bots.create({
        name: "Ada",
        tools: { allow: null, exclude: ["run_command"], apps: {} },
      });
      expect(bot.tools).toEqual({ allow: null, exclude: ["run_command"], apps: {} });
      const raw = () => store!.db.prepare("SELECT tools FROM bots WHERE id = ?").get(bot.id)?.tools;
      expect(JSON.parse(String(raw()))).toEqual({ allow: null, exclude: ["run_command"], apps: {} });

      // Updating something else leaves the list alone.
      expect(store.bots.update(bot.id, { pinned: true })?.tools.exclude).toEqual(["run_command"]);
      expect(store.bots.update(bot.id, { tools: { allow: [], exclude: [], apps: {} } })?.tools).toEqual({
        allow: [],
        exclude: [],
        apps: {},
      });
      expect(store.bots.update(bot.id, { tools: { allow: null, exclude: [], apps: {} } })?.tools).toEqual({
        allow: null,
        exclude: [],
        apps: {},
      });
      expect(raw()).toBeNull();
      expect(store.bots.create({ name: "Plain" }).tools).toEqual({ allow: null, exclude: [], apps: {} });
    });

    it("reads a value it can't understand as no restriction, so one bad row never hides every bot", () => {
      store = openStore(":memory:");
      const good = store.bots.create({
        name: "Good",
        tools: { allow: null, exclude: ["fetch_url"], apps: {} },
      });
      const bad = store.bots.create({ name: "Bad" });
      for (const value of [
        "{not json",
        '{"exclude": "run_command"}',
        '{"exclude":["has space"]}',
        "[]",
        "7",
      ]) {
        store.db.prepare("UPDATE bots SET tools = ? WHERE id = ?").run(value, bad.id);
        expect(store.bots.get(bad.id)?.tools, value).toEqual({ allow: null, exclude: [], apps: {} });
        expect(store.bots.list()).toHaveLength(2);
      }
      expect(store.bots.get(good.id)?.tools.exclude).toEqual(["fetch_url"]);
    });
  });

  it("keeps at most one primary bot", () => {
    store = openStore(":memory:");
    const a = store.bots.create({ name: "A", isPrimary: true });
    const b = store.bots.create({ name: "B", isPrimary: true });
    expect(store.bots.get(a.id)?.isPrimary).toBe(false);
    expect(store.bots.get(b.id)?.isPrimary).toBe(true);

    store.bots.update(a.id, { isPrimary: true });
    expect(
      store.bots
        .list()
        .filter((x) => x.isPrimary)
        .map((x) => x.name),
    ).toEqual(["A"]);
  });
});

describe("settings", () => {
  it("round-trips JSON values", () => {
    store = openStore(":memory:");
    expect(store.settings.get("x")).toBeUndefined();
    store.settings.set("x", { a: [1, 2] });
    store.settings.set("x", { a: [3] });
    expect(store.settings.get("x")).toEqual({ a: [3] });
    store.settings.delete("x");
    expect(store.settings.get("x")).toBeUndefined();
  });

  it("parses a cached value once, until the key is written or deleted", () => {
    store = openStore(":memory:");
    const read = vi.fn((saved: unknown) => ({ n: (saved as { n?: number } | undefined)?.n ?? 0 }));
    expect(store.settings.cached("y", read)).toEqual({ n: 0 });
    expect(store.settings.cached("y", read)).toEqual({ n: 0 });
    expect(read).toHaveBeenCalledTimes(1);
    store.settings.set("y", { n: 2 });
    expect(store.settings.cached("y", read)).toEqual({ n: 2 });
    store.settings.delete("y");
    expect(store.settings.cached("y", read)).toEqual({ n: 0 });
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe("threads", () => {
  it("marks the threads two bots share", () => {
    store = openStore(":memory:");
    const ada = store.bots.create({ name: "Ada" });
    const bea = store.bots.create({ name: "Bea" });
    expect(store.threads.createGroup("Ada ↔ Bea", [ada.id, bea.id], { pair: true }).pair).toBe(true);
    expect(store.threads.createGroup("Team", [ada.id, bea.id]).pair).toBe(false);
  });
});

describe("cached summaries", () => {
  it("go with a deleted bot, a deleted thread and a cleared chat", () => {
    store = openStore(":memory:");
    const ada = store.bots.create({ name: "Ada" });
    const bea = store.bots.create({ name: "Bea" });
    const group = store.threads.createGroup(null, [ada.id, bea.id]);
    const keys = () =>
      store!.db
        .prepare("SELECT key FROM settings WHERE key LIKE 'summary:%' ORDER BY key")
        .all()
        .map((row) => String(row.key));
    const cache = { covered: 3, summary: "old" };
    for (const key of [
      `summary:${ada.threadId}:${ada.id}`,
      `summary:${bea.threadId}:${bea.id}`,
      `summary:${group.id}:${ada.id}`,
      `summary:${group.id}:${bea.id}`,
    ])
      store.settings.set(key, cache);
    store.settings.set("runtime", { keep: true });

    store.messages.clear(bea.threadId);
    expect(keys()).not.toContain(`summary:${bea.threadId}:${bea.id}`);

    store.bots.delete(ada.id);
    expect(keys()).toEqual([`summary:${group.id}:${bea.id}`]);

    store.threads.delete(group.id);
    expect(keys()).toEqual([]);
    expect(store.settings.get("runtime")).toEqual({ keep: true });
  });
});

describe("messages", () => {
  it("saves an update without reading it back, and re-reads rows that changed", () => {
    store = openStore(":memory:");
    const bot = store.bots.create({ name: "Ada" });
    const message = store.messages.create({
      threadId: bot.threadId,
      role: "bot",
      parts: [],
      status: "streaming",
    });
    const parts = [{ type: "text" as const, text: "hello" }];
    const saved = store.messages.update(message.id, { parts });
    expect(saved).toMatchObject({ id: message.id, status: "streaming", parts });
    expect(store.messages.get(message.id)).toEqual(saved);
    expect(store.messages.update(message.id, { status: "done" })).toMatchObject({ parts, status: "done" });
    expect(store.messages.update(`msg_${"0".repeat(32)}`, { status: "done" })).toBeNull();

    // A row changed behind the repo's back is read afresh, not served from an earlier read.
    expect(store.messages.list(bot.threadId)[0]?.parts).toEqual(parts);
    store.db
      .prepare("UPDATE messages SET parts = ? WHERE id = ?")
      .run(JSON.stringify([{ type: "text", text: "changed" }]), message.id);
    expect(store.messages.list(bot.threadId)[0]?.parts).toEqual([{ type: "text", text: "changed" }]);
  });

  it("keeps a message's marks through the updates a streaming reply gets", () => {
    store = openStore(":memory:");
    const bot = store.bots.create({ name: "Ada" });
    const marked = store.messages.create({
      threadId: bot.threadId,
      role: "bot",
      botId: bot.id,
      moderator: true,
      parallel: true,
      status: "streaming",
      parts: [],
    });
    const plain = store.messages.create({ threadId: bot.threadId, role: "bot", botId: bot.id, parts: [] });
    expect(marked).toMatchObject({ moderator: true, parallel: true });
    expect(plain).toMatchObject({ moderator: false, parallel: false });

    // Both kinds of update (the one that writes parts reads fewer columns than the one that doesn't).
    const streamed = store.messages.update(marked.id, { parts: [{ type: "text", text: "## 1. A" }] });
    expect(streamed).toMatchObject({ moderator: true, parallel: true });
    const finished = store.messages.update(marked.id, { status: "done" });
    expect(finished).toMatchObject({ moderator: true, parallel: true });
    expect(store.messages.get(marked.id)).toMatchObject({ moderator: true, parallel: true });
    expect(store.messages.update(plain.id, { parts: [{ type: "text", text: "x" }] })).toMatchObject({
      moderator: false,
      parallel: false,
    });
  });

  it("keeps the moderator mark, which a deleted bot's messages don't get", () => {
    store = openStore(":memory:");
    const ada = store.bots.create({ name: "Ada" });
    const bea = store.bots.create({ name: "Bea" });
    const group = store.threads.createGroup(null, [ada.id, bea.id]);
    const summary = store.messages.create({ threadId: group.id, role: "bot", moderator: true, parts: [] });
    const reply = store.messages.create({ threadId: group.id, role: "bot", botId: bea.id, parts: [] });
    store.bots.delete(bea.id);
    expect(store.messages.get(summary.id)).toMatchObject({ botId: null, moderator: true });
    expect(store.messages.get(reply.id)).toMatchObject({ botId: null, moderator: false });
  });

  it("repairs or flags rows that don't parse instead of failing the whole thread", () => {
    store = openStore(":memory:");
    const bot = store.bots.create({ name: "Ada" });
    const add = (text: string) =>
      store!.messages.create({ threadId: bot.threadId, role: "bot", parts: [{ type: "text", text }] });
    const ok = add("fine");
    const arrayArgs = add("tool");
    const bogus = add("bogus");
    const broken = add("broken");
    const setParts = (id: string, parts: string) =>
      store!.db.prepare("UPDATE messages SET parts = ? WHERE id = ?").run(parts, id);
    setParts(
      arrayArgs.id,
      JSON.stringify([{ type: "tool", callId: "c1", name: "echo", args: ["a", "b"], status: "done" }]),
    );
    setParts(bogus.id, JSON.stringify([{ type: "nope" }]));
    setParts(broken.id, "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const list = store.messages.list(bot.threadId);
      expect(list.map((m) => m.id)).toEqual([ok.id, arrayArgs.id, bogus.id, broken.id]);
      expect(list[1]?.parts[0]).toMatchObject({ type: "tool", args: { value: ["a", "b"] } });
      expect(list[2]?.parts).toEqual([
        { type: "error", code: "unreadable", message: "This message could not be read." },
      ]);
      expect(list[3]?.parts[0]).toMatchObject({ type: "error", code: "unreadable" });
      expect(store.messages.get(bogus.id)?.parts[0]).toMatchObject({ type: "error" });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  describe("recovering messages a restart interrupted", () => {
    const tool = (over: Record<string, unknown>) => ({
      type: "tool" as const,
      callId: "c1",
      name: "run_command",
      args: {},
      status: "running" as const,
      ...over,
    });

    it("closes cards nobody can answer and ends a mid-action turn as an error, not a quiet 'stopped'", () => {
      store = openStore(":memory:");
      const bot = store.bots.create({ name: "Ada" });
      const make = (parts: unknown[]) =>
        store!.messages.create({
          threadId: bot.threadId,
          role: "bot",
          botId: bot.id,
          status: "streaming",
          parts: parts as never,
        });
      const acting = make([
        { type: "text", text: "Sending it now." },
        tool({ callId: "c1", name: "gmail__send", outward: true }),
      ]);
      const waiting = make([
        tool({
          callId: "c2",
          status: "pending_approval",
          // A card is already live-looking when the app dies: it must not stay answerable.
          approval: { id: "apr_1", kind: "terminal", summary: "rm x", badges: [], canAlways: false },
        }),
        { type: "question", questionId: "q1", question: "Which?" },
        { type: "question", questionId: "q2", question: "Done?", answer: "yes" },
        { type: "secret", requestId: "s1", name: "KEY", reason: "login", saved: false },
        { type: "secret", requestId: "s2", name: "KEY2", reason: "login", saved: true },
      ]);
      const reading = make([tool({ callId: "c3", name: "read_file" })]);
      const finished = store.messages.create({
        threadId: bot.threadId,
        role: "bot",
        botId: bot.id,
        status: "done",
        parts: [tool({ status: "done", outward: true })],
      });

      expect(store.messages.recoverInterrupted()).toEqual({ stopped: 2, failed: 1 });

      // Mid-action: an error that names it and says to check, so a retry can't silently do it twice.
      const a = store.messages.get(acting.id)!;
      expect(a.status).toBe("error");
      expect(a.parts[1]).toMatchObject({
        status: "error",
        outward: true,
        result: expect.stringContaining("may or may not have finished"),
      });
      expect(a.parts.at(-1)).toMatchObject({
        type: "error",
        code: "interrupted",
        message: expect.stringContaining("gmail__send"),
      });

      // Waiting for the user: stopped, with nothing left to click.
      const w = store.messages.get(waiting.id)!;
      expect(w.status).toBe("stopped");
      expect(w.parts[0]).toMatchObject({ status: "error", result: "Stopped before anyone answered." });
      expect(w.parts[0]).not.toHaveProperty("approval");
      expect(w.parts[1]).toMatchObject({ expired: true });
      expect(w.parts[2]).not.toHaveProperty("expired"); // answered
      expect(w.parts[3]).toMatchObject({ expired: true });
      expect(w.parts[4]).not.toHaveProperty("expired"); // saved

      // A read-only call that was cut off is simply stopped.
      expect(store.messages.get(reading.id)).toMatchObject({
        status: "stopped",
        parts: [{ status: "error", result: "Stopped before it finished." }],
      });
      expect(store.messages.get(reading.id)!.parts).toHaveLength(1);

      // Finished messages are left as they are, even if an outward call ran in them.
      expect(store.messages.get(finished.id)).toMatchObject({ status: "done" });
      expect(store.messages.recoverInterrupted()).toEqual({ stopped: 0, failed: 0 });
    });

    it("does not call a call 'mid-action' unless it was running: one still waiting for approval never started", () => {
      store = openStore(":memory:");
      const bot = store.bots.create({ name: "Ada" });
      const waiting = store.messages.create({
        threadId: bot.threadId,
        role: "bot",
        botId: bot.id,
        status: "streaming",
        parts: [tool({ status: "pending_approval", outward: true })],
      });
      expect(store.messages.recoverInterrupted()).toEqual({ stopped: 1, failed: 0 });
      expect(store.messages.get(waiting.id)!.status).toBe("stopped");
    });

    it("keeps the new part fields through a read (the schema does not strip them)", () => {
      store = openStore(":memory:");
      const bot = store.bots.create({ name: "Ada" });
      const message = store.messages.create({
        threadId: bot.threadId,
        role: "bot",
        parts: [tool({ status: "denied", outward: true, decidedBy: "timeout" })],
      });
      expect(store.messages.get(message.id)!.parts[0]).toMatchObject({ outward: true, decidedBy: "timeout" });
    });
  });
});

describe("routines", () => {
  it("skips a routine row that can't be read instead of failing every one", () => {
    store = openStore(":memory:");
    const bot = store.bots.create({ name: "Ops" });
    const make = (name: string) =>
      store!.routines.create(
        { botId: bot.id, name, prompt: "Check.", trigger: { type: "interval", minutes: 60 } },
        new Date("2026-11-01T10:00:00Z"),
      );
    const good = make("Good");
    const bad = make("Bad");
    store.db.prepare("UPDATE routines SET trigger = ? WHERE id = ?").run("{broken", bad.id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(store.routines.due(new Date("2026-11-01T12:00:00Z")).map((r) => r.id)).toEqual([good.id]);
      expect(store.routines.list().map((r) => r.id)).toEqual([good.id]);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps a one-time routine's run after Run now or an edit", () => {
    store = openStore(":memory:");
    const bot = store.bots.create({ name: "Ops" });
    const at = "2026-11-05T09:00:00.000Z";
    const routine = store.routines.create(
      { botId: bot.id, name: "Once", prompt: "Go.", trigger: { type: "once", at } },
      new Date("2026-11-03T10:00:00Z"),
    );
    expect(routine.nextRunAt).toBe(at);
    const early = store.routines.finishRun(routine.id, "done", new Date("2026-11-03T11:00:00Z"));
    expect(early?.nextRunAt).toBe(at);
    const edited = store.routines.update(routine.id, { name: "Once more" }, new Date("2026-11-03T12:00:00Z"));
    expect(edited?.nextRunAt).toBe(at);
    const ran = store.routines.finishRun(routine.id, "done", new Date("2026-11-05T09:00:10Z"));
    expect(ran?.nextRunAt).toBeNull();
  });

  it("keeps interval routines on schedule however long a run takes", () => {
    store = openStore(":memory:");
    const bot = store.bots.create({ name: "Ops" });
    const start = new Date("2026-11-01T10:00:00Z");
    const routine = store.routines.create(
      { botId: bot.id, name: "Hourly", prompt: "Check.", trigger: { type: "interval", minutes: 60 } },
      start,
    );
    expect(routine.nextRunAt).toBe("2026-11-01T11:00:00.000Z");
    // Due at 11:00, finished at 11:07: next is 12:00, not 12:07.
    const ran = store.routines.finishRun(routine.id, "done", new Date("2026-11-01T11:07:00Z"));
    expect(ran?.nextRunAt).toBe("2026-11-01T12:00:00.000Z");
    // Asleep through two slots: the next one still sits on the hour.
    const late = store.routines.finishRun(routine.id, "done", new Date("2026-11-01T14:30:00Z"));
    expect(late?.nextRunAt).toBe("2026-11-01T15:00:00.000Z");
    // A run that ends exactly on a slot moves on to the next one.
    const onTime = store.routines.finishRun(routine.id, "done", new Date("2026-11-01T15:00:00Z"));
    expect(onTime?.nextRunAt).toBe("2026-11-01T16:00:00.000Z");
  });
});
