import type { FastifyInstance } from "fastify";

import { libraryTitle, messageText, RenameLibraryItemInput, SaveToLibraryInput } from "@mrog/shared";

import { fail, parse } from "../http";
import type { Services } from "../services";

/** The Library: bot replies you keep. Saving copies the text, so it outlives the chat. */
export function registerLibraryRoutes(app: FastifyInstance, { store, bus }: Services) {
  const changed = () => bus.publish({ type: "data.changed", keys: ["library"] });

  app.get("/api/library", async () => ({ items: store.library.list() }));

  app.post("/api/library", async (request, reply) => {
    const body = parse(SaveToLibraryInput, request.body, reply);
    if (!body) return reply;
    const message = store.messages.get(body.messageId);
    if (!message || message.role !== "bot") return fail(reply, 404, "not_found", "No bot reply has this id.");
    const existing = store.library.byMessage(message.id);
    if (existing) return { item: existing };
    const text = messageText(message).trim();
    if (!text) return fail(reply, 400, "empty", "This reply has no text to save.");
    const item = store.library.add({
      title: body.title ?? libraryTitle(text),
      text,
      botName: message.botId ? (store.bots.get(message.botId)?.name ?? null) : null,
      threadId: message.threadId,
      messageId: message.id,
    });
    changed();
    return reply.code(201).send({ item });
  });

  app.patch<{ Params: { id: string } }>("/api/library/:id", async (request, reply) => {
    const body = parse(RenameLibraryItemInput, request.body, reply);
    if (!body) return reply;
    const item = store.library.rename(request.params.id, body.title);
    if (!item) return fail(reply, 404, "not_found", "No Library item has this id.");
    changed();
    return { item };
  });

  app.delete<{ Params: { id: string } }>("/api/library/:id", async (request, reply) => {
    if (!store.library.delete(request.params.id)) {
      return fail(reply, 404, "not_found", "No Library item has this id.");
    }
    changed();
    return reply.code(204).send();
  });
}
