import { randomBytes } from "node:crypto";

import { newId, nextRun, Routine, type RoutineInput } from "@mrog/shared";

import type { Db } from "./db";

type Row = Record<string, unknown>;

/** One row as a routine; null (with a warning) for a row that can't be read, so it can't break the others. */
function toRoutine(row: Row): Routine | null {
  let trigger: unknown;
  try {
    trigger = JSON.parse(String(row.trigger));
  } catch {
    trigger = undefined;
  }
  const parsed = Routine.safeParse({
    id: row.id,
    botId: row.bot_id,
    name: row.name,
    prompt: row.prompt,
    trigger,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at ?? null,
    lastStatus: row.last_status ?? null,
    nextRunAt: row.next_run_at ?? null,
    webhookSecret: row.webhook_secret ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (parsed.success) return parsed.data;
  console.warn(`[store] routine ${String(row.id)} could not be read`, parsed.error.issues);
  return null;
}

/**
 * When a routine runs next after a run that ended at `at`. Intervals keep to their schedule: whole intervals
 * from the time the run was due, so a long run (or a late tick) doesn't push every later run back.
 */
function nextAfterRun(routine: Routine, at: Date): Date | null {
  const { trigger } = routine;
  if (trigger.type !== "interval" || !routine.nextRunAt) return nextRun(trigger, at, at);
  const every = trigger.minutes * 60_000;
  const scheduled = Date.parse(routine.nextRunAt);
  const missed = Math.max(0, Math.floor((at.getTime() - scheduled) / every) + 1);
  return new Date(scheduled + missed * every);
}

export class RoutineRepo {
  constructor(private readonly db: Db) {}

  list(botId?: string): Routine[] {
    const rows = botId
      ? this.db.prepare("SELECT * FROM routines WHERE bot_id = ? ORDER BY created_at").all(botId)
      : this.db.prepare("SELECT * FROM routines ORDER BY created_at").all();
    return rows.flatMap((row) => toRoutine(row) ?? []);
  }

  get(id: string): Routine | null {
    const row = this.db.prepare("SELECT * FROM routines WHERE id = ?").get(id);
    return row ? toRoutine(row) : null;
  }

  create(input: RoutineInput, now = new Date()): Routine {
    const id = newId("rtn");
    const enabled = input.enabled ?? true;
    const next = enabled ? nextRun(input.trigger, now) : null;
    const secret = input.trigger.type === "webhook" ? randomBytes(18).toString("base64url") : null;
    this.db
      .prepare(
        `INSERT INTO routines (id, bot_id, name, prompt, trigger, enabled, next_run_at, webhook_secret, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.botId,
        input.name,
        input.prompt,
        JSON.stringify(input.trigger),
        enabled ? 1 : 0,
        next?.toISOString() ?? null,
        secret,
        now.toISOString(),
        now.toISOString(),
      );
    return this.get(id)!;
  }

  update(id: string, patch: Partial<RoutineInput>, now = new Date()): Routine | null {
    const current = this.get(id);
    if (!current) return null;
    const merged = { ...current, ...patch, enabled: patch.enabled ?? current.enabled };
    const next = merged.enabled
      ? nextRun(merged.trigger, now, current.lastRunAt ? new Date(current.lastRunAt) : null)
      : null;
    const secret =
      merged.trigger.type === "webhook"
        ? (current.webhookSecret ?? randomBytes(18).toString("base64url"))
        : null;
    this.db
      .prepare(
        `UPDATE routines SET bot_id = ?, name = ?, prompt = ?, trigger = ?, enabled = ?, next_run_at = ?,
           webhook_secret = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        merged.botId,
        merged.name,
        merged.prompt,
        JSON.stringify(merged.trigger),
        merged.enabled ? 1 : 0,
        next?.toISOString() ?? null,
        secret,
        now.toISOString(),
        id,
      );
    return this.get(id);
  }

  /** Records a run and schedules the next one. */
  finishRun(id: string, status: "done" | "error" | "stopped", at = new Date()): Routine | null {
    const current = this.get(id);
    if (!current) return null;
    const next = current.enabled ? nextAfterRun(current, at) : null;
    this.db
      .prepare("UPDATE routines SET last_run_at = ?, last_status = ?, next_run_at = ? WHERE id = ?")
      .run(at.toISOString(), status, next?.toISOString() ?? null, id);
    return this.get(id);
  }

  /** Enabled routines whose next run is at or before `now`. */
  due(now = new Date()): Routine[] {
    return this.db
      .prepare("SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?")
      .all(now.toISOString())
      .flatMap((row) => toRoutine(row) ?? []);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM routines WHERE id = ?").run(id).changes) > 0;
  }
}
