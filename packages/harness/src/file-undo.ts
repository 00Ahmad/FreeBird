import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Bot } from "@mrog/shared";

import { createFileHistory, isVersionId, type FileHistory } from "./file-history";
import { fail, parse } from "./http";
import type { Services } from "./services";

/**
 * Undo for the files a bot changes. Before write_file or edit_file changes a file, a copy of it is kept; the tool's
 * card in the chat then shows Undo, which puts the file back. Plain chats only: the Coding, Job and Client Bots' teams
 * work in their own ways, and keep no copies.
 */
export function installFileUndo(services: Services): FileHistory {
  const { agent, store, bus, turns, config } = services;
  const history = createFileHistory(join(config.dataDir, "file-history"));

  const isTeamBot = (bot: Bot) =>
    services.coding.isTeamBot(bot) || services.jobs.isTeamBot(bot) || services.clients.isTeamBot(bot);

  agent.keepCopyFor = (bot, thread, messageId) =>
    isTeamBot(bot)
      ? undefined
      : async (path, callId) => {
          // Keeping a copy must never stop the write itself.
          const finish = await history
            .keep({ botId: bot.id, threadId: thread.id, messageId, callId }, path)
            .catch((error: Error) => {
              console.warn(`[file-undo] couldn't keep a copy of ${path}: ${error.message}`);
              return undefined;
            });
          if (!finish) return undefined;
          return async (written) => {
            const version = await finish(written).catch((error: Error) => {
              console.warn(`[file-undo] couldn't save a copy: ${error.message}`);
              return null;
            });
            if (!version) return;
            // The card of this call, in the turn's own message, offers Undo.
            const hook = turns.partHooks.get(messageId);
            const part = hook?.parts.find((p) => p.type === "tool" && p.callId === callId);
            if (hook && part?.type === "tool") {
              part.undo = { id: version.id };
              hook.publish();
            }
          };
        };

  services.disposers.push(
    bus.subscribe((event) => {
      if (event.type === "bot.deleted") void history.forgetBot(event.botId).catch(() => undefined);
    }),
  );

  /** Marks the card of an undone change, so the chat shows it and the bot is told in later turns. */
  const markUndone = (messageId: string, callId: string) => {
    const message = store.messages.get(messageId);
    if (!message) return;
    const parts = structuredClone(message.parts);
    const part = parts.find((p) => p.type === "tool" && p.callId === callId);
    if (part?.type !== "tool" || !part.undo) return;
    part.undo = { ...part.undo, undone: true };
    const saved = store.messages.update(messageId, { parts });
    if (saved) bus.publish({ type: "message.updated", message: saved });
  };

  return {
    ...history,
    undo: async (id, force) => {
      const version = await history.get(id);
      // While the reply is still being written, its next save would overwrite the mark.
      if (version && turns.partHooks.has(version.messageId))
        return { ok: false, code: "busy", message: "Wait for the reply to finish, then undo." };
      const result = await history.undo(id, force);
      if (result.ok) markUndone(result.version.messageId, result.version.callId);
      return result;
    },
  };
}

export function registerFileUndoRoutes(app: FastifyInstance, services: Services) {
  app.post<{ Params: { id: string } }>("/api/file-versions/:id/undo", async (request, reply) => {
    const { id } = request.params;
    if (!isVersionId(id)) return fail(reply, 404, "not_found", "That change can no longer be undone.");
    const body = parse(z.object({ force: z.boolean().optional() }), request.body ?? {}, reply);
    if (!body) return reply;
    const result = await services.fileHistory.undo(id, body.force === true);
    if (result.ok) return { version: result.version };
    const status = result.code === "not_found" ? 404 : 409;
    return fail(reply, status, result.code, result.message);
  });
}
