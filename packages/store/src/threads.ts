import { createHash } from "node:crypto";

import { Message, newId, Thread, type MessagePart, type MessageStatus, type Usage } from "@mrog/shared";

import { transaction, type Db } from "./db";
import { deleteSummaries } from "./settings";

type Row = Record<string, unknown>;

export class ThreadRepo {
  constructor(private readonly db: Db) {}

  private members(threadId: string): string[] {
    return this.db
      .prepare("SELECT bot_id FROM thread_members WHERE thread_id = ? ORDER BY rowid")
      .all(threadId)
      .map((row) => String(row.bot_id));
  }

  private toThread(row: Row): Thread {
    return Thread.parse({
      id: row.id,
      kind: row.kind,
      cluster: row.cluster === 1,
      race: row.race === 1,
      pair: row.pair === 1,
      title: row.title ?? null,
      memberIds: this.members(String(row.id)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  list(): Thread[] {
    return this.db
      .prepare("SELECT * FROM threads ORDER BY created_at")
      .all()
      .map((row) => this.toThread(row));
  }

  get(id: string): Thread | null {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id);
    return row ? this.toThread(row) : null;
  }

  createGroup(
    title: string | null,
    memberIds: string[],
    options: { cluster?: boolean; race?: boolean; pair?: boolean } = {},
  ): Thread {
    const id = newId("thr");
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO threads (id, kind, cluster, race, pair, title, created_at, updated_at) VALUES (?, 'group', ?, ?, ?, ?, ?, ?)",
        )
        .run(id, options.cluster ? 1 : 0, options.race ? 1 : 0, options.pair ? 1 : 0, title, now, now);
      const add = this.db.prepare("INSERT INTO thread_members (thread_id, bot_id) VALUES (?, ?)");
      for (const botId of memberIds) add.run(id, botId);
      return this.get(id)!;
    });
  }

  update(id: string, patch: { title?: string | null; memberIds?: string[] }): Thread | null {
    return transaction(this.db, () => {
      if (!this.get(id)) return null;
      if (patch.title !== undefined)
        this.db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(patch.title, id);
      if (patch.memberIds) {
        this.db.prepare("DELETE FROM thread_members WHERE thread_id = ?").run(id);
        const add = this.db.prepare("INSERT INTO thread_members (thread_id, bot_id) VALUES (?, ?)");
        for (const botId of patch.memberIds) add.run(id, botId);
      }
      this.touch(id);
      return this.get(id);
    });
  }

  touch(id: string): void {
    this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  /** Deletes the thread with its messages and cached summaries. */
  delete(id: string): boolean {
    return transaction(this.db, () => {
      const deleted = Number(this.db.prepare("DELETE FROM threads WHERE id = ?").run(id).changes) > 0;
      deleteSummaries(this.db, { threadId: id });
      return deleted;
    });
  }
}

/** Parsed JSON column; undefined when it isn't valid JSON. */
const json = (value: unknown): unknown => {
  try {
    return JSON.parse(String(value));
  } catch {
    return undefined;
  }
};

/** Fixes what older versions stored wrongly: tool arguments that weren't a plain object. */
const repairPart = (part: unknown): unknown => {
  if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "tool") return part;
  const { args } = part as { args?: unknown };
  return args && typeof args === "object" && !Array.isArray(args) ? part : { ...part, args: { value: args } };
};

/**
 * One row as a message. A row that still doesn't parse keeps its place in the thread as an error part rather
 * than failing every read of the thread; null when even that isn't possible.
 */
function toMessage(row: Row): Message | null {
  const raw = json(row.parts);
  const fields = {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    botId: row.bot_id ?? null,
    moderator: row.moderator === 1,
    parts: Array.isArray(raw) ? raw.map(repairPart) : raw,
    status: row.status,
    model: row.model ?? null,
    usage: row.usage ? (json(row.usage) ?? null) : null,
    replyToId: row.reply_to_id ?? null,
    reactions: json(row.reactions ?? "[]") ?? [],
    createdAt: row.created_at,
  };
  const parsed = Message.safeParse(fields);
  if (parsed.success) return parsed.data;
  console.warn(`[store] message ${String(row.id)} could not be read`, parsed.error.issues);
  const fallback = Message.safeParse({
    ...fields,
    parts: [{ type: "error", code: "unreadable", message: "This message could not be read." }],
    usage: null,
    reactions: [],
  });
  if (fallback.success) return fallback.data;
  console.warn(`[store] message ${String(row.id)} skipped`);
  return null;
}

/** What a row held when it was read: a re-read with the same fingerprint is the same message. */
const fingerprint = (row: Row) =>
  createHash("sha1")
    .update(
      [row.parts, row.status, row.usage, row.reactions, row.model, row.bot_id, row.reply_to_id].join(
        "\u0000",
      ),
    )
    .digest("base64");

/** How many recently read messages are kept parsed. */
const PARSED_KEPT = 2_000;

export interface NewMessage {
  threadId: string;
  role: Message["role"];
  botId?: string | null;
  moderator?: boolean;
  parts: MessagePart[];
  status?: MessageStatus;
  model?: string | null;
  replyToId?: string | null;
}

export class MessageRepo {
  /**
   * Recently read messages. Every turn re-reads hundreds of rows that haven't changed since the last one, so an
   * unchanged row (same fingerprint) skips parsing and validation. Callers must treat messages as read-only.
   */
  private readonly parsed = new Map<string, { fingerprint: string; message: Message }>();

  constructor(private readonly db: Db) {}

  private read(row: Row): Message | null {
    const id = String(row.id);
    const print = fingerprint(row);
    const kept = this.parsed.get(id);
    this.parsed.delete(id);
    if (kept?.fingerprint === print) {
      this.parsed.set(id, kept);
      return kept.message;
    }
    const message = toMessage(row);
    if (message) {
      this.parsed.set(id, { fingerprint: print, message });
      if (this.parsed.size > PARSED_KEPT) this.parsed.delete(this.parsed.keys().next().value!);
    }
    return message;
  }

  create(input: NewMessage): Message {
    const id = newId("msg");
    // Strictly increasing timestamps keep ordering stable when two messages land in the same millisecond.
    const last = this.db
      .prepare("SELECT MAX(created_at) AS at FROM messages WHERE thread_id = ?")
      .get(input.threadId);
    let at = new Date();
    if (last?.at && String(last.at) >= at.toISOString())
      at = new Date(new Date(String(last.at)).getTime() + 1);
    this.db
      .prepare(
        `INSERT INTO messages (id, thread_id, role, bot_id, moderator, parts, status, model, reply_to_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        input.role,
        input.botId ?? null,
        input.moderator ? 1 : 0,
        JSON.stringify(input.parts),
        input.status ?? "done",
        input.model ?? null,
        input.replyToId ?? null,
        at.toISOString(),
      );
    this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(at.toISOString(), input.threadId);
    return this.get(id)!;
  }

  get(id: string): Message | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return row ? this.read(row) : null;
  }

  /** Newest `limit` messages of a thread, oldest first; `before` pages further back. */
  list(threadId: string, { limit = 200, before }: { limit?: number; before?: string } = {}): Message[] {
    const rows = before
      ? this.db
          .prepare(
            "SELECT * FROM messages WHERE thread_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(threadId, before, limit)
      : this.db
          .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?")
          .all(threadId, limit);
    return rows.flatMap((row) => this.read(row) ?? []).toReversed();
  }

  /**
   * Saves the patch and returns the merged message (sharing `patch.parts`). Runs every few hundred milliseconds
   * while a reply streams, so it doesn't read back what it wrote, nor parse the old parts it replaces.
   */
  update(
    id: string,
    patch: { parts?: MessagePart[]; status?: MessageStatus; usage?: Usage | null; model?: string | null },
  ): Message | null {
    const current = patch.parts
      ? this.db
          .prepare(
            "SELECT id, thread_id, role, bot_id, '[]' AS parts, status, model, usage, reply_to_id, reactions, created_at FROM messages WHERE id = ?",
          )
          .get(id)
      : this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    const before = current && toMessage(current);
    if (!before) return null;
    const next: Message = {
      ...before,
      parts: patch.parts ?? before.parts,
      status: patch.status ?? before.status,
      usage: patch.usage === undefined ? before.usage : patch.usage,
      model: patch.model === undefined ? before.model : patch.model,
    };
    this.db
      .prepare("UPDATE messages SET parts = ?, status = ?, usage = ?, model = ? WHERE id = ?")
      .run(JSON.stringify(next.parts), next.status, JSON.stringify(next.usage), next.model, id);
    return next;
  }

  /** Adds the reaction, or removes it when it's already there. */
  toggleReaction(id: string, emoji: string): Message | null {
    const current = this.get(id);
    if (!current) return null;
    const reactions = current.reactions.includes(emoji)
      ? current.reactions.filter((existing) => existing !== emoji)
      : [...current.reactions, emoji];
    this.db.prepare("UPDATE messages SET reactions = ? WHERE id = ?").run(JSON.stringify(reactions), id);
    return this.get(id);
  }

  /** Deletes every message in a thread ("Clear chat") and its cached summaries; returns how many went. */
  clear(threadId: string): number {
    return transaction(this.db, () => {
      deleteSummaries(this.db, { threadId });
      return Number(this.db.prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId).changes);
    });
  }

  /**
   * Messages left "streaming" by a crash or restart. They are closed the way a live Stop would close them: calls
   * that were running or waiting for approval are marked as not finished, and cards nobody can answer any more are
   * expired (otherwise they would keep live buttons that lead nowhere).
   *
   * A message that was in the middle of a call that changes things outside the chat (a command, a send, a
   * connected app) is ended as an error that says so, instead of "stopped": it may have happened, and asking again
   * without looking would do it twice.
   */
  recoverInterrupted(): { stopped: number; failed: number } {
    return transaction(this.db, () => {
      const rows = this.db.prepare("SELECT id, parts FROM messages WHERE status = 'streaming'").all();
      const save = this.db.prepare("UPDATE messages SET parts = ?, status = ? WHERE id = ?");
      let stopped = 0;
      let failed = 0;
      for (const row of rows) {
        const raw = json(row.parts);
        const parts = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
        const attempted = new Set<string>();
        for (const part of parts) {
          if (!part || typeof part !== "object") continue;
          if (part.type === "tool" && (part.status === "running" || part.status === "pending_approval")) {
            const running = part.status === "running";
            if (running && part.outward === true) attempted.add(String(part.name));
            part.status = "error";
            part.result = !running
              ? "Stopped before anyone answered."
              : part.outward === true
                ? "The app closed while this was running. It may or may not have finished."
                : "Stopped before it finished.";
            delete part.approval;
          } else if (part.type === "question" && part.answer === undefined) {
            part.expired = true;
          } else if (part.type === "secret" && !part.saved) {
            part.expired = true;
          }
        }
        if (attempted.size > 0) {
          parts.push({
            type: "error",
            code: "interrupted",
            message: `The app closed while ${[...attempted].join(", ")} was running, so it may or may not have finished. Check before asking again, so it isn't done twice.`,
          });
          failed += 1;
        } else {
          stopped += 1;
        }
        save.run(JSON.stringify(parts), attempted.size > 0 ? "error" : "stopped", String(row.id));
      }
      return { stopped, failed };
    });
  }

  /** Total tokens per bot (Usage settings). */
  usageByBot(): { botId: string; inputTokens: number; outputTokens: number; messages: number }[] {
    return this.db
      .prepare(
        `SELECT bot_id,
           COALESCE(SUM(json_extract(usage, '$.inputTokens')), 0) AS input,
           COALESCE(SUM(json_extract(usage, '$.outputTokens')), 0) AS output,
           COUNT(*) AS n
         FROM messages WHERE role = 'bot' AND bot_id IS NOT NULL AND usage IS NOT NULL AND usage != 'null'
         GROUP BY bot_id`,
      )
      .all()
      .map((row) => ({
        botId: String(row.bot_id),
        inputTokens: Number(row.input),
        outputTokens: Number(row.output),
        messages: Number(row.n),
      }));
  }
}
