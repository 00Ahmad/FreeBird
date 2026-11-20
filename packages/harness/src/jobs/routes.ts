import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  BotId,
  CreateJobBotInput,
  HandoffAnswerInput,
  MoveJobInput,
  ReactToJobInput,
  StartJobScanInput,
  UpdateJobProfileInput,
  type Bot,
} from "@mrog/shared";

import { fail, parse } from "../http";
import type { Services } from "../services";
import { JobError } from "./state";

/** The Job Bot's REST routes. Every one answers with the whole project (or an error with a plain message). */
export function registerJobRoutes(app: FastifyInstance, services: Services) {
  const { store, jobs } = services;

  /** The Job Bot a route is about, or a 404. */
  const jobBot = (raw: string, reply: FastifyReply): Bot | undefined => {
    const id = parse(BotId, raw, reply);
    if (!id) return undefined;
    const bot = store.bots.get(id);
    if (!bot?.job) {
      void fail(reply, 404, "not_found", "No Job Bot has this id.");
      return undefined;
    }
    return bot;
  };

  const answer = async (reply: FastifyReply, work: () => unknown, created = false) => {
    try {
      const result = await work();
      return created ? reply.code(201).send(result) : { project: result };
    } catch (error) {
      if (error instanceof JobError) return fail(reply, error.status, error.code, error.message);
      throw error;
    }
  };

  /** A route on one Job Bot, with its body parsed by `schema` (none for a bare POST). */
  const route = <T>(
    method: "post" | "patch",
    path: string,
    schema: z.ZodType<T> | null,
    work: (bot: Bot, input: T, params: Record<string, string>) => unknown,
  ) =>
    app[method]<{ Params: Record<string, string> }>(`/api/bots/:id/job${path}`, async (request, reply) => {
      const bot = jobBot(request.params.id!, reply);
      if (!bot) return reply;
      const input = schema ? parse(schema, request.body, reply) : (undefined as T);
      if (schema && input === undefined) return reply;
      return answer(reply, () => work(bot, input as T, request.params));
    });

  app.post("/api/job-bots", async (request, reply) => {
    const input = parse(CreateJobBotInput, request.body, reply);
    if (!input) return reply;
    return answer(reply, () => jobs.create(input), true);
  });

  app.get<{ Params: { id: string } }>("/api/bots/:id/job", async (request, reply) => {
    const bot = jobBot(request.params.id, reply);
    if (!bot) return reply;
    const project = jobs.get(bot.id);
    return project ? { project } : fail(reply, 404, "not_found", "This Job Bot has no project.");
  });

  route("patch", "/profile", UpdateJobProfileInput, (bot, input) => jobs.updateProfile(bot.id, input));
  route("post", "/profile/approve", null, (bot) => jobs.approveProfile(bot.id));
  route("post", "/scan", StartJobScanInput, (bot, input) => jobs.startScan(bot.id, input.target));
  route("post", "/stop", null, (bot) => jobs.stop(bot.id));
  route("post", "/check-open", null, (bot) => jobs.checkOpen(bot.id));
  route("post", "/handoff", HandoffAnswerInput, (bot, input) => jobs.answerHandoff(bot.id, input.action));
  route("post", "/cards/:cardId/react", ReactToJobInput, (bot, input, params) =>
    jobs.react(bot.id, params.cardId!, input),
  );
  route("patch", "/cards/:cardId", MoveJobInput, (bot, input, params) =>
    jobs.move(bot.id, params.cardId!, input.column),
  );
  route("post", "/suggestions/:suggestionId", z.object({ accept: z.boolean() }), (bot, input, params) =>
    jobs.answerSuggestion(bot.id, params.suggestionId!, input.accept),
  );
}
