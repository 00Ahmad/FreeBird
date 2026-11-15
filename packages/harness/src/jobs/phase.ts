import type { MessagePart } from "@mrog/shared";

import type { Services } from "../services";
import type { Surface } from "../turns";

/** The streaming status message of a step (an interview reply, a scan) in the Job Bot's chat. */
export interface Phase {
  /** Where the role turns' approval cards appear: in this message, which the user is looking at. */
  surface: Surface;
  say(text: string): void;
  close(text: string, status?: "done" | "stopped"): void;
}

/**
 * Opens a status message in the Job Bot's chat, registered as a part hook so the approval cards of the turns that use
 * it as their `surface` show up there. The headline changes in place: replacing the parts would wipe the cards.
 * Null when the bot is gone.
 */
export function openPhase({ store, bus, turns }: Services, botId: string, headline: string): Phase | null {
  const bot = store.bots.get(botId);
  if (!bot) return null;
  const message = store.messages.create({
    threadId: bot.threadId,
    role: "bot",
    botId,
    parts: [{ type: "text", text: headline }],
    status: "streaming",
  });
  bus.publish({ type: "message.created", message });
  const parts: MessagePart[] = [{ type: "text", text: headline }];
  let closed = false;
  const save = (status?: "done" | "stopped") => {
    const saved = store.messages.update(message.id, {
      parts: structuredClone(parts),
      ...(status ? { status } : {}),
    });
    if (saved) bus.publish({ type: "message.updated", message: saved });
  };
  turns.partHooks.set(message.id, { parts, publish: () => !closed && save() });
  return {
    surface: { threadId: bot.threadId, messageId: message.id, botId },
    say(text) {
      if (closed) return;
      (parts[0] as { text: string }).text = text;
      save();
    },
    close(text, status = "done") {
      if (closed) return;
      closed = true;
      turns.partHooks.delete(message.id);
      (parts[0] as { text: string }).text = text;
      // Cards nobody can answer any more.
      for (const part of parts)
        if (part.type === "tool" && (part.status === "pending_approval" || part.status === "running")) {
          part.status = "error";
          part.result = "Stopped before it finished.";
          delete part.approval;
        }
      save(status);
      // Answering a card marks the chat as working; the Job Bot runs no turn of its own that would clear it.
      if (!turns.isBusy(bot.threadId)) turns.setActivity(bot.threadId, null, "idle");
    },
  };
}
