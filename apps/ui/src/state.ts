import { create } from "zustand";

import type { ThreadActivity } from "@mrog/shared";

import type { CodingTab } from "./lib/coding";
import { step, visit, type History } from "./lib/history";
import type { StreamStatus } from "./lib/sse";

interface ConnectionState {
  status: StreamStatus;
  version: string | null;
  lastHeartbeat: number | null;
  setStatus(status: StreamStatus): void;
  hello(version: string): void;
  beat(): void;
}

export const useConnection = create<ConnectionState>((set) => ({
  status: "connecting",
  version: null,
  lastHeartbeat: null,
  setStatus: (status) => set({ status }),
  hello: (version) => set({ version, lastHeartbeat: Date.now() }),
  beat: () => set({ lastHeartbeat: Date.now() }),
}));

export type SettingsSection =
  | "model"
  | "providers"
  | "general"
  | "computer"
  | "browser"
  | "apps"
  | "vault"
  | "usage"
  | "voice"
  | "routines";

interface PullState {
  status: string;
  completed: number | null;
  total: number | null;
  done: boolean;
  error: string | null;
}

/** Dialogs that sit over the whole app. */
type Overlay =
  | "newGroup"
  | "newCluster"
  | "newRace"
  | "newCodingBot"
  | "newJobBot"
  | "newClientBot"
  | "palette"
  | "shortcuts"
  | { avatarFor: string }
  | null;

interface UiState {
  /** The open conversation: a bot's direct thread or a group chat. */
  selectedThreadId: string | null;
  /** What the main pane shows: the selected chat, or the Library. */
  view: "chat" | "library";
  /** The bot whose name is being edited inline in the sidebar. */
  renamingBotId: string | null;
  settingsOpen: SettingsSection | null;
  /** Right-hand panel of the chat. */
  panel: "details" | "computer" | "browser" | "coding" | "job" | "client" | null;
  /** Whether the Coding panel is wanted in a Coding Bot's chat (it is, until the user closes it), and its tab. */
  codingOpen: boolean;
  codingTab: CodingTab;
  /** Whether the Job panel is wanted in a Job Bot's chat (it is, until the user closes it). */
  jobOpen: boolean;
  /** Whether the Client panel is wanted in a Client Bot's chat (it is, until the user closes it). */
  clientOpen: boolean;
  compactSidebar: boolean;
  overlay: Overlay;
  activity: Record<string, { botId: string | null; activity: ThreadActivity }>;
  pulls: Record<string, PullState>;
  history: History;
  /** An action that failed with nowhere else to say so (creating a bot from a shortcut, say); the sidebar shows it. */
  notice: string | null;
  /**
   * A request to open a bot's model menu from a reply that is stuck or failed. A model is resolved when a reply
   * starts, so picking another one does nothing to a reply already under way: when `retryMessageId` is set, the
   * pick also tries that reply again.
   */
  modelSwitch: { botId: string; threadId: string; retryMessageId: string | null } | null;
  askModelSwitch(request: NonNullable<UiState["modelSwitch"]>): void;
  clearModelSwitch(): void;
  select(threadId: string | null): void;
  /** Back / forward through the chats opened before; `exists` skips ones deleted since. */
  go(direction: "back" | "forward", exists: (threadId: string) => boolean): void;
  showLibrary(): void;
  startRename(id: string | null): void;
  openSettings(section: SettingsSection | null): void;
  setPanel(panel: UiState["panel"]): void;
  /** Opens the Coding panel, or closes it (and remembers that) when it is showing. */
  toggleCoding(): void;
  setCodingTab(tab: CodingTab): void;
  /** Opens the Job panel, or closes it (and remembers that) when it is showing. */
  toggleJob(): void;
  /** Opens the Client panel, or closes it (and remembers that) when it is showing. */
  toggleClient(): void;
  toggleCompact(): void;
  setOverlay(overlay: Overlay): void;
  setActivity(threadId: string, botId: string | null, activity: ThreadActivity): void;
  replaceActivity(all: UiState["activity"]): void;
  setPull(model: string, pull: PullState): void;
  /** Forgets one download's progress (dismissed), or all of them (the stream reconnected and may have missed "done"). */
  dropPull(model?: string): void;
  notify(notice: string | null): void;
}

const COMPACT_KEY = "mrog.compactSidebar";
const readCompact = () => {
  try {
    return localStorage.getItem(COMPACT_KEY) === "1";
  } catch {
    return false;
  }
};

export const useUi = create<UiState>((set) => ({
  selectedThreadId: null,
  view: "chat",
  renamingBotId: null,
  settingsOpen: null,
  panel: null,
  codingOpen: true,
  codingTab: "diagram",
  jobOpen: true,
  clientOpen: true,
  compactSidebar: readCompact(),
  overlay: null,
  activity: {},
  pulls: {},
  history: { back: [], forward: [] },
  notice: null,
  modelSwitch: null,
  askModelSwitch: (modelSwitch) => set({ modelSwitch }),
  clearModelSwitch: () => set({ modelSwitch: null }),
  select: (selectedThreadId) =>
    set((state) => ({
      selectedThreadId,
      view: "chat",
      history: visit(state.history, state.selectedThreadId, selectedThreadId),
    })),
  go: (direction, exists) =>
    set((state) => {
      const moved = step(state.history, state.selectedThreadId, direction, exists);
      return moved ? { selectedThreadId: moved.target, view: "chat", history: moved.history } : {};
    }),
  showLibrary: () => set({ view: "library" }),
  startRename: (renamingBotId) => set({ renamingBotId }),
  openSettings: (settingsOpen) => set({ settingsOpen }),
  setPanel: (panel) => set((state) => ({ panel: state.panel === panel ? null : panel })),
  toggleCoding: () =>
    set((state) =>
      state.panel === "coding" ? { panel: null, codingOpen: false } : { panel: "coding", codingOpen: true },
    ),
  setCodingTab: (codingTab) => set({ codingTab }),
  toggleJob: () =>
    set((state) =>
      state.panel === "job" ? { panel: null, jobOpen: false } : { panel: "job", jobOpen: true },
    ),
  toggleClient: () =>
    set((state) =>
      state.panel === "client" ? { panel: null, clientOpen: false } : { panel: "client", clientOpen: true },
    ),
  toggleCompact: () =>
    set((state) => {
      try {
        localStorage.setItem(COMPACT_KEY, state.compactSidebar ? "0" : "1");
      } catch {
        // per-viewer convenience only
      }
      return { compactSidebar: !state.compactSidebar };
    }),
  setOverlay: (overlay) => set({ overlay }),
  setActivity: (threadId, botId, activity) =>
    set((state) => {
      const next = { ...state.activity };
      if (activity === "idle") delete next[threadId];
      else next[threadId] = { botId, activity };
      return { activity: next };
    }),
  replaceActivity: (activity) => set({ activity }),
  setPull: (model, pull) => set((state) => ({ pulls: { ...state.pulls, [model]: pull } })),
  dropPull: (model) =>
    set((state) => {
      if (model === undefined) return { pulls: {} };
      const { [model]: _, ...rest } = state.pulls;
      return { pulls: rest };
    }),
  notify: (notice) => set({ notice }),
}));
