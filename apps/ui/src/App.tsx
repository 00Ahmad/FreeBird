import { lazy, Suspense, useEffect, useState } from "react";

import { COMPOSER_ID } from "./components/chat/Composer";
import { CommandPalette, ShortcutsSheet } from "./components/CommandPalette";
import { AvatarEditor } from "./components/details/AvatarEditor";
import { MainPane } from "./components/MainPane";
import { NewGroupDialog } from "./components/NewGroupDialog";
import { BOT_SEARCH_ID, Sidebar, visibleBots } from "./components/Sidebar";
import { useBots } from "./hooks/bots";
import { useHarnessEvents } from "./hooks/events";
import { useThreads } from "./hooks/threads";
import { useNewBot } from "./hooks/useNewBot";
import { isMac } from "./lib/harness";
import { layerOpen } from "./lib/layers";
import { globalShortcut } from "./lib/shortcuts";
import { useUi } from "./state";

// Loaded when first opened, to keep the startup bundle small.
const SettingsDialog = lazy(() =>
  import("./components/settings/SettingsDialog").then((module) => ({ default: module.SettingsDialog })),
);
const NewClusterDialog = lazy(() =>
  import("./components/NewClusterDialog").then((module) => ({ default: module.NewClusterDialog })),
);
const NewCodingBotDialog = lazy(() =>
  import("./components/NewCodingBotDialog").then((module) => ({ default: module.NewCodingBotDialog })),
);
const NewClientBotDialog = lazy(() =>
  import("./components/clients/NewClientBotDialog").then((module) => ({
    default: module.NewClientBotDialog,
  })),
);
const NewJobBotDialog = lazy(() =>
  import("./components/jobs/NewJobBotDialog").then((module) => ({ default: module.NewJobBotDialog })),
);
const NewRaceDialog = lazy(() =>
  import("./components/NewRaceDialog").then((module) => ({ default: module.NewRaceDialog })),
);

export function App() {
  useHarnessEvents();
  const [query, setQuery] = useState("");
  const compact = useUi((state) => state.compactSidebar);
  const overlay = useUi((state) => state.overlay);
  const settingsOpen = useUi((state) => state.settingsOpen !== null);
  useShortcuts(query);

  return (
    <div
      className={
        compact ? "grid h-full grid-cols-[60px_minmax(0,1fr)]" : "grid h-full grid-cols-[264px_minmax(0,1fr)]"
      }
    >
      <Sidebar query={query} onQuery={setQuery} />
      <MainPane />
      <Suspense fallback={null}>
        {settingsOpen && <SettingsDialog />}
        {overlay === "newCluster" && <NewClusterDialog />}
        {overlay === "newRace" && <NewRaceDialog />}
        {overlay === "newCodingBot" && <NewCodingBotDialog />}
        {overlay === "newJobBot" && <NewJobBotDialog />}
        {overlay === "newClientBot" && <NewClientBotDialog />}
      </Suspense>
      {overlay === "newGroup" && <NewGroupDialog />}
      {overlay === "palette" && <CommandPalette />}
      {overlay === "shortcuts" && <ShortcutsSheet />}
      {overlay && typeof overlay === "object" && <AvatarEditor botId={overlay.avatarFor} />}
    </div>
  );
}

/** Keyboard shortcuts; dictation (Mod+D) and Add selection (Mod+L) live in the chat. */
function useShortcuts(query: string) {
  const { data: bots } = useBots();
  const { data: threads } = useThreads();
  const newBot = useNewBot();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      const shortcut = globalShortcut(event, { mac: isMac(), typing });
      if (!shortcut) return;
      const ui = useUi.getState();
      const handled = () => event.preventDefault();

      // These two close what they opened; everything else leaves the keyboard to an open dialog or menu.
      if (shortcut.type === "palette") {
        if (layerOpen() && ui.overlay !== "palette") return;
        handled();
        ui.setOverlay(ui.overlay === "palette" ? null : "palette");
        return;
      }
      if (shortcut.type === "settings") {
        if (layerOpen() && !ui.settingsOpen) return;
        handled();
        ui.openSettings(ui.settingsOpen ? null : "general");
        return;
      }
      if (layerOpen()) return;

      const list = visibleBots(bots, query);
      const at = list.findIndex((bot) => bot.threadId === ui.selectedThreadId);

      switch (shortcut.type) {
        case "details":
          handled();
          ui.setPanel("details");
          break;
        case "cycle": {
          handled();
          const next = shortcut.backwards
            ? (at <= 0 ? list.length : at) - 1
            : (at + 1) % Math.max(1, list.length);
          const bot = list[next];
          if (bot) ui.select(bot.threadId);
          break;
        }
        case "back":
        case "forward":
          handled();
          ui.go(shortcut.type, (id) => !!threads?.some((thread) => thread.id === id));
          break;
        case "newBot":
          handled();
          void newBot();
          break;
        case "newGroup":
          handled();
          ui.setOverlay("newGroup");
          break;
        case "apps":
          handled();
          ui.openSettings("apps");
          break;
        case "shortcuts":
          handled();
          ui.setOverlay("shortcuts");
          break;
        case "compact":
          handled();
          ui.toggleCompact();
          break;
        case "findBot":
          handled();
          if (ui.compactSidebar) ui.toggleCompact();
          setTimeout(() => document.getElementById(BOT_SEARCH_ID)?.focus(), 0);
          break;
        case "composer":
          handled();
          document.getElementById(COMPOSER_ID)?.focus();
          break;
        case "select": {
          const bot = list[shortcut.number - 1];
          if (bot) {
            handled();
            ui.select(bot.threadId);
          }
          break;
        }
        case "step": {
          handled();
          const next = shortcut.delta === 1 ? Math.min(at + 1, list.length - 1) : Math.max(at - 1, 0);
          const bot = list[next];
          if (bot) ui.select(bot.threadId);
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bots, threads, query, newBot]);
}
