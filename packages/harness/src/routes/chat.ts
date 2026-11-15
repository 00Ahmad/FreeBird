import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { BotId, MessageId, repeatsAction, SendMessageInput, ThreadId } from "@mrog/shared";

import { fail, parse } from "../http";
import { LANE_TOOLS } from "../parallel-lanes";
import type { Services } from "../services";

const ListQuery = z.object({
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export function registerChatRoutes(
  app: FastifyInstance,
  { store, turns, bus, discussions, coding, jobs, clients, agent }: Services,
) {
  /** Why Allow tools can't be used for this message, or null. */
  const parallelToolsRefusal = (
    thread: { kind: string; memberIds: string[] },
    parallel: boolean,
  ): string | null => {
    if (!parallel) return "Allow tools works together with Parallel Bots: turn Parallel on first.";
    const bot = thread.kind === "group" ? undefined : store.bots.get(thread.memberIds[0] ?? "");
    if (!bot) return "Allow tools works in a chat with one bot.";
    if (bot.coding) return "Allow tools isn't available for a Coding Bot.";
    if (bot.job) return "Allow tools isn't available for a Job Bot.";
    if (bot.client) return "Allow tools isn't available for a Client Bot.";
    if (bot.visual)
      return "Allow tools isn't available for a Visual Bot: it uses the web by looking at the screen, not with search and fetch_url.";
    const allowed = agent
      .listTools(bot)
      .filter((tool) => tool.enabled && LANE_TOOLS.some((name) => name === tool.name));
    if (allowed.length === 0)
      return "Allow tools needs web_search or fetch_url, and this bot has neither turned on (see its Tools).";
    return null;
  };

  app.get("/api/threads", async () => ({ threads: store.threads.list() }));

  app.get("/api/activity", async () => ({ activity: turns.activities() }));

  app.get<{ Params: { id: string } }>("/api/threads/:id/messages", async (request, reply) => {
    const id = parse(ThreadId, request.params.id, reply);
    if (!id) return reply;
    const query = parse(ListQuery, request.query, reply);
    if (!query) return reply;
    if (!store.threads.get(id)) return fail(reply, 404, "not_found", "No thread has this id.");
    return { messages: store.messages.list(id, query) };
  });

  app.post<{ Params: { id: string } }>("/api/threads/:id/messages", async (request, reply) => {
    const id = parse(ThreadId, request.params.id, reply);
    if (!id) return reply;
    const input = parse(SendMessageInput, request.body, reply);
    if (!input) return reply;
    if (!input.text.trim() && !input.images?.length) {
      return fail(reply, 400, "invalid_request", "A message needs text or an image.");
    }
    const thread = store.threads.get(id);
    if (!thread) return fail(reply, 404, "not_found", "No thread has this id.");
    // Groups, clusters and races have several bots, and Parallel Bots is one bot answering as three.
    if (input.parallel && thread.kind === "group") {
      return fail(reply, 400, "invalid_request", "Parallel Bots works in a chat with one bot.");
    }
    if (input.parallelTools) {
      const refusal = parallelToolsRefusal(thread, input.parallel === true);
      if (refusal) return fail(reply, 400, "invalid_request", refusal);
    }
    const message = await turns.send(thread, input);
    return reply.code(201).send({ message });
  });

  /**
   * "Try again" on a reply that failed, stalled or never got going: the bot answers the user's message afresh,
   * without a new message from the user. The rules live here, not only in the UI: another window, or a stale
   * button, can post this too.
   */
  app.post<{ Params: { id: string } }>("/api/threads/:id/retry", async (request, reply) => {
    const id = parse(ThreadId, request.params.id, reply);
    if (!id) return reply;
    const body = parse(z.object({ botId: BotId, messageId: MessageId }), request.body, reply);
    if (!body) return reply;
    const thread = store.threads.get(id);
    if (!thread) return fail(reply, 404, "not_found", "No thread has this id.");
    const bot = store.bots.get(body.botId);
    if (!bot || !thread.memberIds.includes(bot.id))
      return fail(reply, 400, "not_a_member", "That bot isn't in this chat.");
    // A Coding Bot's team is run by its project, which has its own Resume.
    if (coding.isTeamBot(bot))
      return fail(
        reply,
        409,
        "not_retryable",
        "The Coding Bot's team is run from its own chat: use Resume there.",
      );
    // A Job Bot's team is run by its scans, started from its own chat.
    if (jobs.isTeamBot(bot))
      return fail(
        reply,
        409,
        "not_retryable",
        "The Job Bot's team is run from its own chat: start a scan there.",
      );
    if (clients.isTeamBot(bot))
      return fail(
        reply,
        409,
        "not_retryable",
        "The Client Bot's team is run from its own chat: start a scan there.",
      );
    const target = store.messages.get(body.messageId);
    if (!target || target.threadId !== id || target.role !== "bot" || target.botId !== bot.id)
      return fail(reply, 404, "not_found", "That isn't a reply from this bot in this chat.");
    // Only the newest reply: an older one was followed by more conversation, which a retry would answer out of order.
    const newest = store.messages
      .list(id, { limit: 100 })
      .findLast((message) => message.role === "bot" && message.botId === bot.id);
    if (newest?.id !== target.id)
      return fail(reply, 409, "stale", "That reply is no longer the latest one from this bot.");
    if (target.status === "done")
      return fail(reply, 409, "not_retryable", "That reply finished; there is nothing to try again.");
    // A role's search or page fetch only reads: asking again does nothing twice.
    const repeats = target.parallelTools
      ? repeatsAction({
          parts: target.parts.filter(
            (part) => !(part.type === "tool" && LANE_TOOLS.some((name) => name === part.name)),
          ),
        })
      : repeatsAction(target);
    if (repeats)
      return fail(
        reply,
        409,
        "may_repeat",
        "It may already have done something. Check, then ask again yourself so it isn't done twice.",
      );
    return reply.code(202).send(turns.retry(thread, bot, target.id));
  });

  /** "Clear chat": a fresh start for the conversation. Memory, skills and files are kept. */
  app.delete<{ Params: { id: string } }>("/api/threads/:id/messages", async (request, reply) => {
    const id = parse(ThreadId, request.params.id, reply);
    if (!id) return reply;
    if (!store.threads.get(id)) return fail(reply, 404, "not_found", "No thread has this id.");
    discussions.stop(id);
    turns.stop(id);
    // Cached summaries of the old conversation go too.
    const removed = store.messages.clear(id);
    // The event log deletes this chat's log on exactly this event (keys include "messages" and a thread id), because
    // the log is a copy of the messages. Publish it for nothing else, or a chat's log is wiped.
    bus.publish({ type: "data.changed", keys: ["messages"], threadId: id });
    return { removed };
  });

  app.post<{ Params: { id: string } }>("/api/threads/:id/stop", async (request, reply) => {
    const id = parse(ThreadId, request.params.id, reply);
    if (!id) return reply;
    discussions.stop(id);
    turns.stop(id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/messages/:id", async (request, reply) => {
    const id = parse(MessageId, request.params.id, reply);
    if (!id) return reply;
    const message = store.messages.get(id);
    return message ? { message } : fail(reply, 404, "not_found", "No message has this id.");
  });
}
