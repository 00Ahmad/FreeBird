import { LibraryItem, newId } from "@mrog/shared";

import type { Db } from "./db";

type Row = Record<string, unknown>;

const toItem = (row: Row) =>
  LibraryItem.parse({
    id: row.id,
    title: row.title,
    text: row.text,
    botName: row.bot_name ?? null,
    threadId: row.thread_id ?? null,
    messageId: row.message_id ?? null,
    createdAt: row.created_at,
  });

export class LibraryRepo {
  constructor(private readonly db: Db) {}

  list(): LibraryItem[] {
    return this.db.prepare("SELECT * FROM library_items ORDER BY created_at DESC").all().map(toItem);
  }

  get(id: string): LibraryItem | null {
    const row = this.db.prepare("SELECT * FROM library_items WHERE id = ?").get(id);
    return row ? toItem(row) : null;
  }

  byMessage(messageId: string): LibraryItem | null {
    const row = this.db.prepare("SELECT * FROM library_items WHERE message_id = ?").get(messageId);
    return row ? toItem(row) : null;
  }

  add(input: Omit<LibraryItem, "id" | "createdAt">): LibraryItem {
    const id = newId("lib");
    this.db
      .prepare(
        "INSERT INTO library_items (id, title, text, bot_name, thread_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.title,
        input.text,
        input.botName,
        input.threadId,
        input.messageId,
        new Date().toISOString(),
      );
    return this.get(id)!;
  }

  rename(id: string, title: string): LibraryItem | null {
    const changed = this.db.prepare("UPDATE library_items SET title = ? WHERE id = ?").run(title, id).changes;
    return Number(changed) ? this.get(id) : null;
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM library_items WHERE id = ?").run(id).changes) > 0;
  }
}
