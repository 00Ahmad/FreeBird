import { create } from "zustand";

import type { CodingProject } from "@mrog/shared";

import {
  acknowledgeCard,
  advanceActivity,
  MOVED_FOR_MS,
  pruneMoved,
  type CardActivity,
} from "./lib/codingActivity";

interface ActivityStore {
  /** What changed on each Coding Bot's board lately. */
  byBot: Record<string, CardActivity>;
  /** A project arrived (fetched, streamed or returned by an action). */
  advance(project: Pick<CodingProject, "botId" | "cards">): void;
  /** The new QA comment on this card has been seen. */
  acknowledge(botId: string, cardId: string): void;
  /** The Coding Bot was deleted. */
  forget(botId: string): void;
}

export const useCardActivity = create<ActivityStore>((set, get) => ({
  byBot: {},
  advance: (project) => {
    const next = advanceActivity(get().byBot[project.botId] ?? null, project.cards, Date.now());
    set((state) => ({ byBot: { ...state.byBot, [project.botId]: next } }));
    // Let the flash end by itself.
    if (Object.keys(next.moved).length === 0) return;
    setTimeout(() => {
      const current = get().byBot[project.botId];
      if (!current) return;
      const pruned = pruneMoved(current, Date.now());
      if (pruned !== current) set((state) => ({ byBot: { ...state.byBot, [project.botId]: pruned } }));
    }, MOVED_FOR_MS + 50);
  },
  acknowledge: (botId, cardId) => {
    const current = get().byBot[botId];
    if (!current) return;
    const next = acknowledgeCard(current, cardId);
    if (next !== current) set((state) => ({ byBot: { ...state.byBot, [botId]: next } }));
  },
  forget: (botId) => {
    if (!(botId in get().byBot)) return;
    set((state) => {
      const { [botId]: _, ...byBot } = state.byBot;
      return { byBot };
    });
  },
}));
