import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { ROUTINE_MARKER, RoutineInput, type Routine } from "@mrog/shared";

import { fail, parse } from "./http";
import type { Services } from "./services";
import { TurnCancelled } from "./turns";

const TICK_MS = 30_000;
const MAX_PAYLOAD = 64 * 1024;

/** Runs routines on their schedule and on demand, posting each run into the bot's own chat. */
export class RoutineRunner {
  private readonly running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private catchUp: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly services: Pick<Services, "store" | "bus" | "turns">) {}

  start(tickMs = TICK_MS): void {
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref();
    // Catch up on anything that came due while the app was closed.
    this.catchUp = setTimeout(() => void this.tick(), 2_000);
    this.catchUp.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.catchUp);
  }

  /** Starts every routine that is due. Never throws: a failure here would otherwise repeat on every tick. */
  async tick(now = new Date()): Promise<void> {
    try {
      for (const routine of this.services.store.routines.due(now)) {
        this.run(routine).catch((error: unknown) =>
          console.error(`[routines] ${routine.name} could not run`, error),
        );
      }
    } catch (error) {
      console.error("[routines] checking for due routines failed", error);
    }
  }

  /** Why the routine can't run right now, or null when it can. */
  blocked(routine: Routine): string | null {
    if (this.running.has(routine.id)) return "This routine is already running.";
    const bot = this.services.store.bots.get(routine.botId);
    if (!bot || !this.services.store.threads.get(bot.threadId)) return "This routine's bot no longer exists.";
    return null;
  }

  /** Runs once now; resolves with the run's final status. */
  async run(routine: Routine, extra?: string): Promise<"done" | "error" | "stopped" | "skipped"> {
    const { store, bus, turns } = this.services;
    if (this.running.has(routine.id)) return "skipped";
    const bot = store.bots.get(routine.botId);
    const thread = bot ? store.threads.get(bot.threadId) : null;
    if (!bot || !thread) return "skipped";
    this.running.add(routine.id);
    try {
      // Before anything happens, so a run cut short by the app closing isn't due again (and repeated) at the next start.
      store.routines.startRun(routine.id);
      const text = `${ROUTINE_MARKER} Routine “${routine.name}”\n${routine.prompt}${extra ? `\n\n${extra}` : ""}`;
      const message = store.messages.create({
        threadId: thread.id,
        role: "system",
        parts: [{ type: "text", text }],
      });
      bus.publish({ type: "message.created", message });
      const reply = await turns.start(thread, bot, "routine");
      const status = reply.status === "done" ? "done" : reply.status === "stopped" ? "stopped" : "error";
      store.routines.finishRun(routine.id, status);
      return status;
    } catch (error) {
      // Waiting behind another turn when Stop was pressed (or its bot was deleted): it never ran.
      if (error instanceof TurnCancelled) {
        store.routines.finishRun(routine.id, "stopped");
        return "stopped";
      }
      console.error(`[routines] ${routine.name} failed`, error);
      store.routines.finishRun(routine.id, "error");
      return "error";
    } finally {
      this.running.delete(routine.id);
      bus.publish({ type: "data.changed", keys: ["routines"] });
    }
  }
}

const secretMatches = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function registerRoutineRoutes(app: FastifyInstance, services: Services, runner: RoutineRunner) {
  const { store, bus } = services;
  const changed = () => bus.publish({ type: "data.changed", keys: ["routines"] });

  app.get<{ Querystring: { botId?: string } }>("/api/routines", async (request) => ({
    routines: store.routines.list(request.query.botId),
  }));

  app.post("/api/routines", async (request, reply) => {
    const input = parse(RoutineInput, request.body, reply);
    if (!input) return reply;
    if (!store.bots.get(input.botId)) return fail(reply, 400, "invalid_request", "Unknown bot.");
    const routine = store.routines.create(input);
    changed();
    return reply.code(201).send({ routine });
  });

  app.patch<{ Params: { id: string } }>("/api/routines/:id", async (request, reply) => {
    const patch = parse(RoutineInput.partial(), request.body, reply);
    if (!patch) return reply;
    if (patch.botId && !store.bots.get(patch.botId))
      return fail(reply, 400, "invalid_request", "Unknown bot.");
    const routine = store.routines.update(request.params.id, patch);
    if (!routine) return fail(reply, 404, "not_found", "No routine has this id.");
    changed();
    return { routine };
  });

  app.delete<{ Params: { id: string } }>("/api/routines/:id", async (request, reply) => {
    if (!store.routines.delete(request.params.id))
      return fail(reply, 404, "not_found", "No routine has this id.");
    changed();
    return reply.code(204).send();
  });

  /** "Test" / "Run now". */
  app.post<{ Params: { id: string } }>("/api/routines/:id/run", async (request, reply) => {
    const routine = store.routines.get(request.params.id);
    if (!routine) return fail(reply, 404, "not_found", "No routine has this id.");
    const blocked = runner.blocked(routine);
    if (blocked) return fail(reply, 409, "busy", blocked);
    void runner.run(routine);
    return reply.code(202).send({ started: true });
  });

  /** Webhook trigger. Outside /api: no app token, the routine's own secret instead. */
  app.post<{ Params: { id: string }; Querystring: { key?: string } }>(
    "/hooks/:id",
    async (request, reply) => {
      const routine = store.routines.get(request.params.id);
      const key = request.query.key ?? "";
      if (
        !routine ||
        routine.trigger.type !== "webhook" ||
        !routine.webhookSecret ||
        !secretMatches(key, routine.webhookSecret)
      ) {
        return fail(reply, 404, "not_found", "Not found.");
      }
      if (!routine.enabled) return fail(reply, 409, "paused", "This routine is paused.");
      const blocked = runner.blocked(routine);
      if (blocked) return fail(reply, 409, "busy", blocked);
      const raw =
        typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? null, null, 2);
      const payload = raw.length > MAX_PAYLOAD ? `${raw.slice(0, MAX_PAYLOAD)}\n…(cut)` : raw;
      void runner.run(routine, `Webhook payload:\n\`\`\`\n${payload}\n\`\`\``);
      return reply.code(202).send({ accepted: true });
    },
  );
}
