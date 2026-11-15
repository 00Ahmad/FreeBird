import { create } from "zustand";

import type { CodingProject } from "@mrog/shared";

import { attentionMark, canSee } from "./lib/codingAttention";

const KEY = "mrog.codingSeen.v1";

function load(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function save(seen: Record<string, string>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {
    // Per-viewer convenience only: without storage a badge comes back after a reload until the chat is opened.
  }
}

interface SeenStore {
  /** Per Coding Bot: the status, and when it was reached, that the user last saw in its chat. */
  byBot: Record<string, string>;
  /** The Coding Bot's chat is in front of the user with the project as it is. */
  see(project: Pick<CodingProject, "botId" | "status" | "startedAt" | "log">): void;
  forget(botId: string): void;
}

export const useCodingSeen = create<SeenStore>((set, get) => ({
  byBot: load(),
  see: (project) => {
    if (!canSee(project)) return;
    const mark = attentionMark(project);
    if (get().byBot[project.botId] === mark) return;
    const byBot = { ...get().byBot, [project.botId]: mark };
    save(byBot);
    set({ byBot });
  },
  forget: (botId) => {
    if (!(botId in get().byBot)) return;
    const { [botId]: _, ...byBot } = get().byBot;
    save(byBot);
    set({ byBot });
  },
}));
