import { z } from "zod";

import { BotId } from "./ids";

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");

/** When a routine runs (UI-SPEC §10). Times are local to this computer. */
export const RoutineTrigger = z.discriminatedUnion("type", [
  /** Days 0 = Sunday … 6 = Saturday. */
  z.object({
    type: z.literal("weekly"),
    days: z.array(z.number().int().min(0).max(6)).min(1),
    times: z.array(Time).min(1).max(12),
  }),
  z.object({ type: z.literal("interval"), minutes: z.number().int().min(5).max(1440) }),
  z.object({ type: z.literal("once"), at: z.iso.datetime() }),
  /** Runs when something POSTs to its webhook URL. */
  z.object({ type: z.literal("webhook") }),
  /** Only runs when you press Run now ("Teach a task" saves these). */
  z.object({ type: z.literal("manual") }),
]);
export type RoutineTrigger = z.infer<typeof RoutineTrigger>;

export const Routine = z.object({
  id: z.string(),
  botId: BotId,
  name: z.string().min(1).max(80),
  /** What the bot does each run. */
  prompt: z.string().min(1).max(8000),
  trigger: RoutineTrigger,
  enabled: z.boolean(),
  lastRunAt: z.iso.datetime().nullable(),
  lastStatus: z.enum(["done", "error", "stopped"]).nullable(),
  nextRunAt: z.iso.datetime().nullable(),
  /** Only for webhook routines; the full URL is shown in the UI. */
  webhookSecret: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Routine = z.infer<typeof Routine>;

export const RoutineInput = z.object({
  botId: BotId,
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(8000),
  trigger: RoutineTrigger,
  enabled: z.boolean().optional(),
});
export type RoutineInput = z.infer<typeof RoutineInput>;

export const ROUTINE_MARKER = "🔁";

/** Next time a trigger fires after `from` (null for webhook/manual, or a one-off that is past or has run). */
export function nextRun(trigger: RoutineTrigger, from: Date, lastRunAt: Date | null = null): Date | null {
  switch (trigger.type) {
    case "interval": {
      const base = lastRunAt ?? from;
      const next = new Date(base.getTime() + trigger.minutes * 60_000);
      return next > from ? next : from;
    }
    case "once": {
      const at = new Date(trigger.at);
      // A run before its time ("Run now", a test) leaves it scheduled; only a run at or after its time ends it.
      if (lastRunAt && lastRunAt >= at) return null;
      return at < new Date(from.getTime() - 60_000) ? null : at;
    }
    case "weekly": {
      const times = trigger.times.toSorted();
      for (let offset = 0; offset <= 7; offset++) {
        const day = new Date(from);
        day.setDate(day.getDate() + offset);
        if (!trigger.days.includes(day.getDay())) continue;
        for (const time of times) {
          const [h, m] = time.split(":").map(Number) as [number, number];
          const candidate = new Date(day);
          candidate.setHours(h, m, 0, 0);
          if (candidate > from) return candidate;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

export function describeTrigger(trigger: RoutineTrigger): string {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  switch (trigger.type) {
    case "weekly": {
      const days =
        trigger.days.length === 7
          ? "Every day"
          : trigger.days.length === 5 && [1, 2, 3, 4, 5].every((d) => trigger.days.includes(d))
            ? "Weekdays"
            : trigger.days
                .toSorted()
                .map((d) => DAYS[d])
                .join(", ");
      return `${days} at ${trigger.times.join(", ")}`;
    }
    case "interval":
      return trigger.minutes % 60 === 0 ? `Every ${trigger.minutes / 60} h` : `Every ${trigger.minutes} min`;
    case "once":
      return `Once, ${new Date(trigger.at).toLocaleString()}`;
    case "webhook":
      return "When its webhook is called";
    case "manual":
      return "When you run it";
  }
}
