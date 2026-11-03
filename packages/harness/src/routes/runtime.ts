import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { RuntimeSettings } from "@mrog/shared";

import { attempt, fail, parse } from "../http";
import type { Services } from "../services";

const ModelName = z.object({
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[\w.:/@-]+$/, "Not a model name"),
});

export function registerRuntimeRoutes(
  app: FastifyInstance,
  { runtime, catalog, bus, ollamaLauncher }: Services,
) {
  const pulls = new Map<string, AbortController>();

  app.get("/api/runtime", async () => ({ status: await runtime.status() }));

  app.patch("/api/runtime/settings", async (request, reply) => {
    const patch = parse(RuntimeSettings.partial(), request.body, reply);
    if (!patch) return reply;
    const settings = runtime.update(patch);
    if (patch.ollamaUrl) catalog.invalidate();
    return { settings };
  });

  app.post("/api/runtime/warmup", async (request, reply) => {
    const warmed = await attempt(reply, () => runtime.warmup());
    if (warmed === undefined) return reply;
    catalog.invalidate();
    return { warmed };
  });

  /** Starts the local Ollama if it isn't running; waits until it answers. */
  app.post("/api/runtime/start", async (request, reply) => {
    const started = await attempt(reply, () => ollamaLauncher.start());
    if (started === undefined) return reply;
    return { started: started === "started" };
  });

  app.post("/api/runtime/unload", async (request, reply) => {
    const input = parse(ModelName, request.body, reply);
    if (!input) return reply;
    if ((await attempt(reply, () => runtime.ollama.unload(input.model))) === undefined) return reply;
    catalog.invalidate();
    return reply.code(204).send();
  });

  /** Starts a download; progress arrives as runtime.pull events. */
  app.post("/api/runtime/pull", async (request, reply) => {
    const input = parse(ModelName, request.body, reply);
    if (!input) return reply;
    if (pulls.has(input.model))
      return fail(reply, 409, "already_pulling", "That model is already downloading.");
    const controller = new AbortController();
    pulls.set(input.model, controller);
    void (async () => {
      let error: string | null = null;
      let last = 0;
      try {
        for await (const progress of runtime.ollama.pull(input.model, controller.signal)) {
          // A pull reports many times a second; a few updates a second is plenty for a progress bar.
          if (Date.now() - last < 250) continue;
          last = Date.now();
          bus.publish({ type: "runtime.pull", model: input.model, ...progress, done: false, error: null });
        }
      } catch (caught) {
        error = (caught as Error).message;
      } finally {
        pulls.delete(input.model);
        catalog.invalidate();
        bus.publish({
          type: "runtime.pull",
          model: input.model,
          status: error ? "failed" : "success",
          completed: null,
          total: null,
          done: true,
          error,
        });
        bus.publish({ type: "data.changed", keys: ["models"] });
      }
    })();
    return reply.code(202).send({ started: true });
  });

  app.post("/api/runtime/pull/cancel", async (request, reply) => {
    const input = parse(ModelName, request.body, reply);
    if (!input) return reply;
    pulls.get(input.model)?.abort();
    return reply.code(204).send();
  });

  app.get<{ Querystring: { refresh?: string } }>("/api/models", async (request) => {
    return catalog.all(request.query.refresh === "1");
  });
}
