import type { FastifyInstance } from "fastify";

import { BotId, CreateBotInput, UpdateBotInput, type Bot } from "@mrog/shared";

import { fail, parse } from "../http";
import type { Services } from "../services";

export function registerBotRoutes(app: FastifyInstance, { store, bus, delegation, agent }: Services) {
  /** Making a bot primary demotes the old one; tell the UI about both. */
  const publishDemotedPrimary = (previous: Bot | undefined, current: Bot) => {
    if (!previous || previous.id === current.id || !current.isPrimary) return;
    const demoted = store.bots.get(previous.id);
    if (demoted) bus.publish({ type: "bot.updated", bot: demoted });
  };
  const currentPrimary = () => store.bots.list().find((bot) => bot.isPrimary);

  app.get("/api/bots", async () => ({ bots: store.bots.list() }));

  app.post("/api/bots", async (request, reply) => {
    const input = parse(CreateBotInput, request.body, reply);
    if (!input) return reply;
    const previous = currentPrimary();
    const bot = store.bots.create(input);
    bus.publish({ type: "bot.created", bot });
    const thread = store.threads.get(bot.threadId);
    if (thread) bus.publish({ type: "thread.created", thread });
    publishDemotedPrimary(previous, bot);
    return reply.code(201).send({ bot });
  });

  app.patch<{ Params: { id: string } }>("/api/bots/:id", async (request, reply) => {
    const id = parse(BotId, request.params.id, reply);
    if (!id) return reply;
    const patch = parse(UpdateBotInput, request.body, reply);
    if (!patch) return reply;
    const previous = currentPrimary();
    const bot = store.bots.update(id, patch);
    if (!bot) return fail(reply, 404, "not_found", "No bot has this id.");
    bus.publish({ type: "bot.updated", bot });
    publishDemotedPrimary(previous, bot);
    return { bot };
  });

  /** The tools this bot has, on or off, for the Details panel. Ones its list names but aren't offered now are included. */
  app.get<{ Params: { id: string } }>("/api/bots/:id/tools", async (request, reply) => {
    const id = parse(BotId, request.params.id, reply);
    if (!id) return reply;
    const bot = store.bots.get(id);
    if (!bot) return fail(reply, 404, "not_found", "No bot has this id.");
    return { tools: agent.listTools(bot) };
  });

  app.delete<{ Params: { id: string } }>("/api/bots/:id", async (request, reply) => {
    const id = parse(BotId, request.params.id, reply);
    if (!id) return reply;
    const bot = store.bots.get(id);
    if (!bot) return fail(reply, 404, "not_found", "No bot has this id.");
    // Its temporary helpers go with it.
    for (const helper of store.bots.list())
      if (helper.parentId === id && helper.temporary) delegation.removeBot(helper);
    delegation.removeBot(bot);
    return reply.code(204).send();
  });
}
