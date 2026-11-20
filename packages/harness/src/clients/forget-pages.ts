import { fold } from "@mrog/jobs";
import { CLIENT_ROLES, type ClientProject, type Lead } from "@mrog/shared";

import type { Services } from "../services";
import type { ClientTeam } from "./team";

/** What a message about a forgotten lead says instead. */
export const FORGOTTEN = "(Removed: you forgot this lead, so what was read about it here was deleted.)";

/** The addresses and the name a lead's pages can be found by in the role threads. */
function marksOf(lead: Lead): string[] {
  const urls = [
    lead.url,
    ...lead.signals.map((s) => s.url),
    ...lead.evidence.map((e) => e.url),
    ...lead.contacts.map((c) => c.url),
    ...lead.records.map((r) => r.url),
  ];
  return [...new Set([...urls, lead.domain ?? "", lead.company].map((mark) => fold(mark).trim()))].filter(
    (mark) => mark.length >= 4,
  );
}

/**
 * Forget means forget (3.1): every message in the team's role threads that holds what was read about the lead (its
 * pages, quotes and contact details), and the role's reply to it, is replaced by a short note. The threads stay, one
 * per role with the Client Bot. Returns how many messages were cleared.
 */
export function forgetPagesOf(
  { store, bus }: Pick<Services, "store" | "bus">,
  team: Pick<ClientTeam, "pairOf">,
  project: ClientProject,
  lead: Lead,
): number {
  const marks = marksOf(lead);
  let cleared = 0;
  for (const role of CLIENT_ROLES) {
    const roleBotId = project.roles[role].botId;
    const thread = team.pairOf(project.botId, roleBotId);
    if (!thread) continue;
    let replyNext = false;
    for (const message of store.messages.list(thread.id)) {
      const holds = marks.some((mark) => fold(JSON.stringify(message.parts)).includes(mark));
      // The role's reply right after a task about the lead goes too: it may quote the page.
      const reply = replyNext && message.botId === roleBotId;
      replyNext = holds && message.botId !== roleBotId;
      if (!holds && !reply) continue;
      const updated = store.messages.update(message.id, { parts: [{ type: "text", text: FORGOTTEN }] });
      if (!updated) continue;
      bus.publish({ type: "message.updated", message: updated });
      cleared += 1;
    }
  }
  return cleared;
}
