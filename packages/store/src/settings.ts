import type { Db } from "./db";

/** Values `SettingsRepo.cached` has parsed, per database, until their key is written or deleted. */
const parsedValues = new WeakMap<Db, Map<string, unknown>>();

function parsedOf(db: Db): Map<string, unknown> {
  let values = parsedValues.get(db);
  if (!values) parsedValues.set(db, (values = new Map()));
  return values;
}

/** Small JSON key/value store for app settings. */
export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }

  /**
   * The value as `read` turns it (e.g. validated, with defaults), worked out once and reused until the key is
   * written again. For settings read many times per turn; each key should always be read with the same `read`,
   * and the result treated as read-only.
   */
  cached<T>(key: string, read: (saved: unknown) => T): T {
    const values = parsedOf(this.db);
    if (values.has(key)) return values.get(key) as T;
    const value = read(this.get(key));
    values.set(key, value);
    return value;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
    parsedOf(this.db).delete(key);
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    parsedOf(this.db).delete(key);
  }
}

/**
 * Drops the cached history summaries (`summary:<threadId>:<botId>`, written by turns) of a thread or a bot,
 * when it's deleted or its chat is cleared.
 */
export function deleteSummaries(db: Db, of: { threadId: string } | { botId: string }): void {
  if ("threadId" in of) {
    const prefix = `summary:${of.threadId}:`;
    db.prepare("DELETE FROM settings WHERE substr(key, 1, length(?)) = ?").run(prefix, prefix);
  } else {
    const suffix = `:${of.botId}`;
    db.prepare("DELETE FROM settings WHERE key LIKE 'summary:%' AND substr(key, -length(?)) = ?").run(
      suffix,
      suffix,
    );
  }
  for (const key of parsedOf(db).keys()) if (key.startsWith("summary:")) parsedOf(db).delete(key);
}
