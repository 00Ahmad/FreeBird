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
import { useUi } from "./state";

// Loaded when first opened, to keep the startup bundle small.
const SettingsDialog = lazy(() =>
  import("./components/settings/SettingsDialog").then((module) => ({ default: module.SettingsDialog })),
);
const NewClusterDialog = lazy(() =>
  import("./components/NewClusterDialog").then((module) => ({ default: module.NewClusterDialog })),
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
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      const ui = useUi.getState();
      const handled = () => event.preventDefault();

      // These two close what they opened; everything else leaves the keyboard to an open dialog or menu.
      if (mod && key === "k" && (!layerOpen() || ui.overlay === "palette")) {
        handled();
        ui.setOverlay(ui.overlay === "palette" ? null : "palette");
        return;
      }
      if (mod && !event.shiftKey && event.key === "," && (!layerOpen() || ui.settingsOpen)) {
        handled();
        ui.openSettings(ui.settingsOpen ? null : "general");
        return;
      }
      if (layerOpen()) return;

      const list = visibleBots(bots, query);
      const at = list.findIndex((bot) => bot.threadId === ui.selectedThreadId);
      // event.code for Alt combinations: on a Mac, Option turns the key into another character ("∫" for B).
      const details = isMac()
        ? event.metaKey && ((event.shiftKey && key === "i") || (event.altKey && event.code === "KeyB"))
        : event.ctrlKey && event.altKey && event.code === "KeyB";

      if (details) {
        handled();
        ui.setPanel("details");
      } else if (event.ctrlKey && event.key === "Tab") {
        handled();
        const next = event.shiftKey ? (at <= 0 ? list.length : at) - 1 : (at + 1) % Math.max(1, list.length);
        const bot = list[next];
        if (bot) ui.select(bot.threadId);
      } else if (mod && !event.shiftKey && (event.key === "[" || event.key === "]")) {
        handled();
        ui.go(event.key === "[" ? "back" : "forward", (id) => !!threads?.some((thread) => thread.id === id));
      } else if (mod && !event.shiftKey && key === "n") {
        handled();
        void newBot();
      } else if (mod && event.shiftKey && key === "n") {
        handled();
        ui.setOverlay("newGroup");
      } else if (mod && event.shiftKey && key === "m") {
        handled();
        ui.openSettings("apps");
      } else if (mod && event.key === "/") {
        handled();
        ui.setOverlay("shortcuts");
      } else if (mod && !event.shiftKey && key === "b") {
        handled();
        ui.toggleCompact();
      } else if (mod && event.shiftKey && key === "f") {
        handled();
        if (ui.compactSidebar) ui.toggleCompact();
        setTimeout(() => document.getElementById(BOT_SEARCH_ID)?.focus(), 0);
      } else if (mod && !event.shiftKey && !event.altKey && key === "i") {
        // Not with Shift: Ctrl+Shift+I opens the developer tools.
        handled();
        document.getElementById(COMPOSER_ID)?.focus();
      } else if (mod && /^[1-9]$/.test(event.key)) {
        const bot = list[Number(event.key) - 1];
        if (bot) {
          handled();
          ui.select(bot.threadId);
        }
      } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && !typing) {
        handled();
        const next = event.key === "ArrowDown" ? Math.min(at + 1, list.length - 1) : Math.max(at - 1, 0);
        const bot = list[next];
        if (bot) ui.select(bot.threadId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bots, threads, query, newBot]);
}
