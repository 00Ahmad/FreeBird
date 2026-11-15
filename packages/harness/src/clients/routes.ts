import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  AddToListInput,
  BotId,
  CreateClientBotInput,
  ForgetLeadInput,
  HandoffAnswerInput,
  LeadNoteInput,
  MoveLeadInput,
  ReactToLeadInput,
  RemoveFromListInput,
  SetClientKeyInput,
  SetLookalikesInput,
  StartClientScanInput,
  UpdateLookalikeInput,
  UpdateOfferInput,
  WatchInput,
  WatchListInput,
  type Bot,
} from "@mrog/shared";

import { fail, parse } from "../http";
import type { Services } from "../services";
import { ClientError } from "./state";

/** The Client Bot's REST routes. Every one answers with the whole project (or an error with a plain message). */
export function registerClientRoutes(app: FastifyInstance, services: Services) {
  const { store, clients } = services;

  const clientBot = (raw: string, reply: FastifyReply): Bot | undefined => {
    const id = parse(BotId, raw, reply);
    if (!id) return undefined;
    const bot = store.bots.get(id);
    if (!bot?.client) {
      void fail(reply, 404, "not_found", "No Client Bot has this id.");
      return undefined;
    }
    return bot;
  };

  const answer = async (reply: FastifyReply, work: () => unknown, created = false) => {
    try {
      const result = await work();
      return created ? reply.code(201).send(result) : { project: result };
    } catch (error) {
      if (error instanceof ClientError) return fail(reply, error.status, error.code, error.message);
      throw error;
    }
  };

  const route = <T>(
    method: "post" | "patch",
    path: string,
    schema: z.ZodType<T> | null,
    work: (bot: Bot, input: T, params: Record<string, string>) => unknown,
  ) =>
    app[method]<{ Params: Record<string, string> }>(`/api/bots/:id/client${path}`, async (request, reply) => {
      const bot = clientBot(request.params.id!, reply);
      if (!bot) return reply;
      const input = schema ? parse(schema, request.body, reply) : (undefined as T);
      if (schema && input === undefined) return reply;
      return answer(reply, () => work(bot, input as T, request.params));
    });

  app.post("/api/client-bots", async (request, reply) => {
    const input = parse(CreateClientBotInput, request.body, reply);
    if (!input) return reply;
    return answer(reply, () => clients.create(input), true);
  });

  /** Which register keys are saved: never the keys. */
  app.get("/api/client-bots/keys", async () => ({ keys: clients.keys() }));
  app.post("/api/client-bots/keys", async (request, reply) => {
    const input = parse(SetClientKeyInput, request.body, reply);
    if (!input) return reply;
    return { keys: clients.setKey(input.name, input.key) };
  });

  app.get<{ Params: { id: string } }>("/api/bots/:id/client", async (request, reply) => {
    const bot = clientBot(request.params.id, reply);
    if (!bot) return reply;
    const project = clients.get(bot.id);
    return project ? { project } : fail(reply, 404, "not_found", "This Client Bot has no project.");
  });

  app.get<{ Params: { id: string } }>("/api/bots/:id/client/export.csv", async (request, reply) => {
    const bot = clientBot(request.params.id, reply);
    if (!bot) return reply;
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="leads.csv"')
      .send(clients.exportCsv(bot.id));
  });

  route("patch", "/profile", UpdateOfferInput, (bot, input) => clients.updateProfile(bot.id, input));
  route("post", "/profile/approve", null, (bot) => clients.approveProfile(bot.id));
  route("post", "/scan", StartClientScanInput, (bot, input) =>
    clients.startScan(bot.id, input.target, input.kinds),
  );
  route("post", "/stop", null, (bot) => clients.stop(bot.id));
  route("post", "/handoff", HandoffAnswerInput, (bot, input) => clients.answerHandoff(bot.id, input.action));
  route("post", "/leads/:leadId/react", ReactToLeadInput, (bot, input, params) =>
    clients.react(bot.id, params.leadId!, input),
  );
  route("patch", "/leads/:leadId", MoveLeadInput, (bot, input, params) =>
    clients.move(bot.id, params.leadId!, input.column),
  );
  route("post", "/leads/:leadId/note", LeadNoteInput, (bot, input, params) =>
    clients.note(bot.id, params.leadId!, input.note),
  );
  route("post", "/leads/:leadId/watch", WatchInput, (bot, input, params) =>
    clients.watch(bot.id, params.leadId!, input.watch),
  );
  route("post", "/leads/:leadId/forget", ForgetLeadInput, (bot, input, params) =>
    clients.forget(bot.id, params.leadId!, input.block),
  );
  route("post", "/suggestions/:suggestionId", z.object({ accept: z.boolean() }), (bot, input, params) =>
    clients.answerSuggestion(bot.id, params.suggestionId!, input.accept),
  );
  route("post", "/lists/add", AddToListInput, (bot, input) =>
    clients.addToList(bot.id, input.list, input.text),
  );
  route("post", "/lists/remove", RemoveFromListInput, (bot, input) =>
    clients.removeFromList(bot.id, input.list, input.entry),
  );
  route("post", "/lookalikes", SetLookalikesInput, (bot, input) => clients.setLookalikes(bot.id, input.text));
  route("patch", "/lookalikes", UpdateLookalikeInput, (bot, input) =>
    clients.updateLookalike(bot.id, input.profile, input.approved),
  );
  route("post", "/watchlist", WatchListInput, (bot, input) => clients.setWatchList(bot.id, input.off));
}
