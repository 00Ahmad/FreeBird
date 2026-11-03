import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MIGRATIONS, type Migration } from "./migrations";

export type Db = DatabaseSync;

/** Opens (creating if needed) the database at `path`, or an in-memory one for ":memory:", and migrates it. */
export function openDatabase(path: string, migrations: readonly Migration[] = MIGRATIONS): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  migrate(db, migrations);
  return db;
}

export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
  );`);
  const applied = new Set(
    db
      .prepare("SELECT id FROM _migrations")
      .all()
      .map((row) => Number(row.id)),
  );
  const ran: number[] = [];
  for (const migration of migrations.toSorted((a, b) => a.id - b.id)) {
    if (applied.has(migration.id)) continue;
    transaction(db, () => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
    });
    ran.push(migration.id);
  }
  return ran;
}

/** Runs `fn` in a transaction; nested calls join the outer one. */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
