import { MemoryNote, newId, Skill, type SkillInput } from "@mrog/shared";

import type { Db } from "./db";

type Row = Record<string, unknown>;

const toNote = (row: Row) =>
  MemoryNote.parse({
    id: row.id,
    botId: row.bot_id,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export class MemoryRepo {
  constructor(private readonly db: Db) {}

  list(botId: string): MemoryNote[] {
    return (
      this.db
        // Blank notes (saved by older versions) would fail to parse and break the whole list.
        .prepare("SELECT * FROM memories WHERE bot_id = ? AND trim(text) <> '' ORDER BY created_at")
        .all(botId)
        .map(toNote)
    );
  }

  add(botId: string, text: string): MemoryNote {
    const id = newId("mem");
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO memories (id, bot_id, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, botId, text, now, now);
    return toNote(this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id)!);
  }

  update(id: string, text: string): MemoryNote | null {
    const changed = this.db
      .prepare("UPDATE memories SET text = ?, updated_at = ? WHERE id = ?")
      .run(text, new Date().toISOString(), id).changes;
    if (!Number(changed)) return null;
    return toNote(this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id)!);
  }

  delete(id: string): MemoryNote | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    if (!row) return null;
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    return toNote(row);
  }
}

const toSkill = (row: Row) =>
  Skill.parse({
    id: row.id,
    botId: row.bot_id ?? null,
    name: row.name,
    prompt: row.prompt,
    createdAt: row.created_at,
  });

export class SkillRepo {
  constructor(private readonly db: Db) {}

  /** Skills a bot can use: its own plus the shared ones. Without a bot, all of them. */
  list(botId?: string): Skill[] {
    const rows = botId
      ? this.db.prepare("SELECT * FROM skills WHERE bot_id IS NULL OR bot_id = ? ORDER BY name").all(botId)
      : this.db.prepare("SELECT * FROM skills ORDER BY name").all();
    return rows.map(toSkill);
  }

  add(input: SkillInput): Skill {
    const id = newId("skl");
    this.db
      .prepare("INSERT INTO skills (id, bot_id, name, prompt, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.botId, input.name, input.prompt, new Date().toISOString());
    return toSkill(this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id)!);
  }

  update(id: string, input: Partial<SkillInput>): Skill | null {
    const row = this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id);
    if (!row) return null;
    const current = toSkill(row);
    const next = { ...current, ...input };
    this.db
      .prepare("UPDATE skills SET bot_id = ?, name = ?, prompt = ? WHERE id = ?")
      .run(next.botId, next.name, next.prompt, id);
    return toSkill(this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id)!);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM skills WHERE id = ?").run(id).changes) > 0;
  }
}
