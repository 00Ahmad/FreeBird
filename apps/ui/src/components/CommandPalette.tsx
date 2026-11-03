import { Flag, Keyboard, MessagesSquare, Network, PanelLeft, Settings, UserPlus, Users } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { BotAvatar, cn } from "@mrog/ui-kit";

import { useBots } from "../hooks/bots";
import { useThreads } from "../hooks/threads";
import { useNewBot } from "../hooks/useNewBot";
import { useUi } from "../state";
import { Modal } from "./Modal";
import { SETTINGS_PAGES } from "./settings/pages";
import { groupTitle } from "./Sidebar";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run(): void;
}

/** Cmd/Ctrl+K: jump to any bot or chat, or run an action. */
export function CommandPalette() {
  const { data: bots } = useBots();
  const { data: threads } = useThreads();
  const newBot = useNewBot();
  const { setOverlay, select, openSettings, toggleCompact } = useUi(
    useShallow((state) => ({
      setOverlay: state.setOverlay,
      select: state.select,
      openSettings: state.openSettings,
      toggleCompact: state.toggleCompact,
    })),
  );
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const close = () => setOverlay(null);

  const commands = useMemo<Command[]>(() => {
    const botMap = new Map((bots ?? []).map((bot) => [bot.id, bot]));
    return [
      ...(bots ?? [])
        .filter((bot) => !bot.clusterId)
        .map((bot) => ({
          id: bot.id,
          label: bot.name,
          hint: bot.label ?? "Bot",
          icon: <BotAvatar avatar={bot.avatar} size={18} />,
          run: () => select(bot.threadId),
        })),
      ...(threads ?? [])
        .filter((thread) => thread.kind === "group")
        .map((thread) => ({
          id: thread.id,
          label: groupTitle(thread, botMap),
          hint: "Group chat",
          icon: <MessagesSquare size={16} />,
          run: () => select(thread.id),
        })),
      {
        id: "new-bot",
        label: "Create a Bot",
        hint: "Ctrl+N",
        icon: <UserPlus size={16} />,
        run: () => void newBot(),
      },
      {
        id: "new-group",
        label: "New group chat",
        hint: "Ctrl+Shift+N",
        icon: <Users size={16} />,
        run: () => setOverlay("newGroup"),
      },
      {
        id: "new-cluster",
        label: "New cluster",
        icon: <Network size={16} />,
        run: () => setOverlay("newCluster"),
      },
      {
        id: "new-race",
        label: "New race",
        icon: <Flag size={16} />,
        run: () => setOverlay("newRace"),
      },
      {
        id: "compact",
        label: "Toggle compact sidebar",
        hint: "Ctrl+B",
        icon: <PanelLeft size={16} />,
        run: toggleCompact,
      },
      {
        id: "shortcuts",
        label: "Keyboard shortcuts",
        hint: "Ctrl+/",
        icon: <Keyboard size={16} />,
        run: () => setOverlay("shortcuts"),
      },
      ...SETTINGS_PAGES.map((page) => ({
        id: `settings-${page.id}`,
        label: `Settings: ${page.label}`,
        icon: <Settings size={16} />,
        run: () => openSettings(page.id),
      })),
    ];
  }, [bots, threads, newBot, select, setOverlay, openSettings, toggleCompact]);

  const needle = query.trim().toLowerCase();
  const results = commands
    .filter((command) => !needle || command.label.toLowerCase().includes(needle))
    .slice(0, 12);
  const index = Math.min(active, Math.max(0, results.length - 1));
  const run = (command: Command | undefined) => {
    if (!command) return;
    // Close first so actions that open another overlay aren't overridden.
    close();
    command.run();
  };

  return (
    <Modal title="Command palette" onClose={close} bare className="max-w-xl self-start mt-[12vh]">
      <input
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : results.length - 1;
            setActive((index + step) % Math.max(1, results.length));
          }
          if (event.key === "Enter") run(results[index]);
        }}
        placeholder="Search bots, chats and actions"
        aria-label="Search bots, chats and actions"
        className="border-b border-border bg-transparent px-5 py-4 text-[15px] outline-none"
      />
      <ul className="max-h-96 overflow-y-auto p-1.5" role="listbox">
        {results.map((command, i) => (
          <li key={command.id}>
            <button
              type="button"
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(command)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13.5px]",
                i === index && "bg-selected",
              )}
            >
              <span className="flex w-5 justify-center text-ink-2">{command.icon}</span>
              <span className="flex-1 truncate">{command.label}</span>
              {command.hint && <span className="text-xs text-ink-3">{command.hint}</span>}
            </button>
          </li>
        ))}
        {results.length === 0 && <li className="px-3 py-2 text-[13px] text-ink-3">Nothing matches.</li>}
      </ul>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Search bots, chats and actions", "Mod+K"],
  ["Search bots", "Mod+Shift+F"],
  ["Jump to sidebar bot 1–9", "Mod+1…9"],
  ["Previous / next bot", "Alt+↑ / Alt+↓"],
  ["Cycle bots", "Ctrl+Tab / Ctrl+Shift+Tab"],
  ["Back / forward", "Mod+[ / Mod+]"],
  ["New bot", "Mod+N"],
  ["New group chat", "Mod+Shift+N"],
  ["All shortcuts", "Mod+/"],
  ["Compact sidebar", "Mod+B"],
  ["Focus the message box", "Mod+I"],
  ["Add selected text to the chat", "Mod+L"],
  ["Settings", "Mod+,"],
  ["Connect apps", "Mod+Shift+M"],
  ["Conversation details", "Ctrl+Alt+B (Mac: Cmd+Shift+I or Cmd+Alt+B)"],
  ["Send", "Enter"],
  ["New line", "Shift+Enter"],
  ["Dictate", "Mod+D"],
];

export function ShortcutsSheet() {
  const setOverlay = useUi((state) => state.setOverlay);
  const mod = (window.mrog?.platform ?? navigator.platform).toLowerCase().includes("mac") ? "⌘" : "Ctrl";
  return (
    <Modal title="Keyboard shortcuts" onClose={() => setOverlay(null)}>
      <table className="m-5 text-[13px]">
        <tbody>
          {SHORTCUTS.map(([label, keys]) => (
            <tr key={label}>
              <td className="py-1 pr-8 text-ink-2">{label}</td>
              <td className="py-1">
                <kbd className="rounded-md border border-border bg-hover px-1.5 py-0.5 font-mono text-[12px]">
                  {keys.replaceAll("Mod", mod)}
                </kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
