import {
  AlertTriangle,
  BookOpen,
  ScanEye,
  Bell,
  BellOff,
  ChevronDown,
  ChevronRight,
  Copy,
  Eraser,
  Eye,
  EyeOff,
  FolderInput,
  FolderMinus,
  FolderPlus,
  Flag,
  MessagesSquare,
  Network,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Star,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";

import type { Bot, Thread } from "@mrog/shared";
import { cn, IconButton } from "@mrog/ui-kit";

import { useBots, useDeleteBot, useUpdateBot } from "../hooks/bots";
import { useDeleteGroup, useDuplicateBot, useUpdateGroup } from "../hooks/team";
import { messagesKey, useThreads } from "../hooks/threads";
import { useNewBot, useNewVisualBot } from "../hooks/useNewBot";
import { api } from "../lib/api";
import { isMac } from "../lib/harness";
import { importTemplate } from "../lib/templates";
import { useUi } from "../state";
import { BotRow } from "./BotRow";
import { ConnectionStatus } from "./ConnectionStatus";
import { ContextMenu, type MenuEntry } from "./ContextMenu";

export const BOT_SEARCH_ID = "bot-search";

/** Bots shown in the main list, in order; used by keyboard navigation too. */
export function visibleBots(bots: Bot[] | undefined, query: string): Bot[] {
  const needle = query.trim().toLowerCase();
  return (bots ?? []).filter(
    (bot) => !bot.hidden && !bot.clusterId && (!needle || bot.name.toLowerCase().includes(needle)),
  );
}

export function groupTitle(thread: Thread, bots: Map<string, Bot>): string {
  return thread.title ?? thread.memberIds.map((id) => bots.get(id)?.name ?? "?").join(", ");
}

type Menu = { x: number; y: number; entries: MenuEntry[] };

export function Sidebar({ query, onQuery }: { query: string; onQuery(query: string): void }) {
  const { data: bots, isError } = useBots();
  const { data: threads } = useThreads();
  const update = useUpdateBot();
  const remove = useDeleteBot();
  const duplicate = useDuplicateBot();
  const updateGroup = useUpdateGroup();
  const deleteGroup = useDeleteGroup();
  const newBot = useNewBot();
  const newVisualBot = useNewVisualBot();
  const {
    selectedThreadId,
    startRename,
    select,
    compactSidebar,
    setOverlay,
    openSettings,
    view,
    showLibrary,
    notice,
    notify,
  } = useUi(
    useShallow((state) => ({
      selectedThreadId: state.selectedThreadId,
      startRename: state.startRename,
      select: state.select,
      compactSidebar: state.compactSidebar,
      setOverlay: state.setOverlay,
      openSettings: state.openSettings,
      view: state.view,
      showLibrary: state.showLibrary,
      notice: state.notice,
      notify: state.notify,
    })),
  );
  const [menu, setMenu] = useState<Menu | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const closeMenu = useCallback(() => setMenu(null), []);
  const queryClient = useQueryClient();

  const botMap = useMemo(() => new Map((bots ?? []).map((bot) => [bot.id, bot])), [bots]);
  const visible = useMemo(() => visibleBots(bots, query), [bots, query]);
  const hidden = useMemo(() => (bots ?? []).filter((bot) => bot.hidden && !bot.clusterId), [bots]);
  const sections = useMemo(() => {
    const names = [
      ...new Set(visible.map((bot) => bot.section).filter((name): name is string => !!name)),
    ].toSorted();
    return [{ name: null as string | null, bots: visible.filter((bot) => !bot.section) }].concat(
      names.map((name) => ({ name, bots: visible.filter((bot) => bot.section === name) })),
    );
  }, [visible]);
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (threads ?? [])
      .filter((thread) => thread.kind === "group")
      .filter((thread) => !needle || groupTitle(thread, botMap).toLowerCase().includes(needle))
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [threads, botMap, query]);
  const clusters = useMemo(() => groups.filter((thread) => thread.cluster && !thread.race), [groups]);
  const races = useMemo(() => groups.filter((thread) => thread.race), [groups]);
  const groupChats = useMemo(() => groups.filter((thread) => !thread.cluster), [groups]);

  /** A fresh start: messages go, memory, skills and files stay. */
  const clearChat = (threadId: string, name: string) => {
    if (
      !window.confirm(
        `Clear the chat with ${name}? Its messages are deleted; memory, skills and files are kept.`,
      )
    )
      return;
    api(`/threads/${threadId}/messages`, { method: "DELETE" }).then(
      () => queryClient.setQueryData(messagesKey(threadId), []),
      (error: Error) => notify(`Couldn't clear the chat: ${error.message}`),
    );
  };

  const open = (event: MouseEvent, entries: MenuEntry[]) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, entries });
  };

  const botEntries = (bot: Bot): MenuEntry[] => {
    const existingSections = [...new Set((bots ?? []).map((b) => b.section).filter((s): s is string => !!s))];
    const patch = (value: Parameters<typeof update.mutate>[0]["patch"]) =>
      update.mutate({ id: bot.id, patch: value });
    return [
      bot.pinned
        ? { label: "Unpin", icon: <PinOff size={14} />, onSelect: () => patch({ pinned: false }) }
        : { label: "Pin", icon: <Pin size={14} />, onSelect: () => patch({ pinned: true }) },
      { label: "Rename Bot", icon: <Pencil size={14} />, onSelect: () => startRename(bot.id) },
      { label: "Clear chat", icon: <Eraser size={14} />, onSelect: () => clearChat(bot.threadId, bot.name) },
      ...(bot.isPrimary
        ? []
        : [
            {
              label: "Make Primary Bot",
              icon: <Star size={14} />,
              onSelect: () => patch({ isPrimary: true }),
            },
          ]),
      {
        label: "Move to new section…",
        icon: <FolderPlus size={14} />,
        onSelect: () => {
          const name = window.prompt("Section name")?.trim();
          if (name) patch({ section: name.slice(0, 40) });
        },
      },
      ...existingSections
        .filter((name) => name !== bot.section)
        .map((name) => ({
          label: `Move to ${name}`,
          icon: <FolderInput size={14} />,
          onSelect: () => patch({ section: name }),
        })),
      ...(bot.section
        ? [
            {
              label: "Remove from section",
              icon: <FolderMinus size={14} />,
              onSelect: () => patch({ section: null }),
            },
          ]
        : []),
      bot.notifications
        ? {
            label: "Turn off notifications",
            icon: <BellOff size={14} />,
            onSelect: () => patch({ notifications: false }),
          }
        : {
            label: "Turn on notifications",
            icon: <Bell size={14} />,
            onSelect: () => patch({ notifications: true }),
          },
      { label: "Duplicate", icon: <Copy size={14} />, onSelect: () => duplicate.mutate(bot.id) },
      bot.hidden
        ? { label: "Show in sidebar", icon: <Eye size={14} />, onSelect: () => patch({ hidden: false }) }
        : { label: "Hide from sidebar", icon: <EyeOff size={14} />, onSelect: () => patch({ hidden: true }) },
      "separator",
      {
        label: "Delete",
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => {
          if (
            window.confirm(`Delete “${bot.name}”? This can't be undone. Hide it instead to keep its work.`)
          ) {
            remove.mutate(bot.id);
          }
        },
      },
    ];
  };

  const groupEntries = (thread: Thread): MenuEntry[] => [
    {
      label: "Clear chat",
      icon: <Eraser size={14} />,
      onSelect: () => clearChat(thread.id, groupTitle(thread, botMap)),
    },
    {
      label: "Rename chat",
      icon: <Pencil size={14} />,
      onSelect: () => {
        const title = window.prompt("Chat name", thread.title ?? "")?.trim();
        if (title !== undefined) updateGroup.mutate({ id: thread.id, patch: { title: title || null } });
      },
    },
    "separator",
    {
      label: "Delete chat",
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () =>
        window.confirm(
          thread.race
            ? "Delete this race, its racers and their work?"
            : thread.cluster
              ? "Delete this cluster, its experts and its messages?"
              : "Delete this group chat and its messages?",
        ) && deleteGroup.mutate(thread.id),
    },
  ];

  const plusEntries: MenuEntry[] = [
    { label: "Create a Bot", icon: <UserPlus size={14} />, onSelect: () => void newBot() },
    { label: "New Visual Bot", icon: <ScanEye size={14} />, onSelect: () => void newVisualBot() },
    { label: "New group chat", icon: <Users size={14} />, onSelect: () => setOverlay("newGroup") },
    { label: "New cluster", icon: <Network size={14} />, onSelect: () => setOverlay("newCluster") },
    { label: "New race", icon: <Flag size={14} />, onSelect: () => setOverlay("newRace") },
    { label: "Import bot template…", icon: <Upload size={14} />, onSelect: () => void importTemplate() },
  ];

  const mod = isMac() ? "⌘" : "Ctrl+";
  const row = (bot: Bot) => (
    <BotRow
      key={bot.id}
      bot={bot}
      compact={compactSidebar}
      selected={bot.threadId === selectedThreadId}
      onContextMenu={(event) => open(event, botEntries(bot))}
    />
  );

  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-border bg-sidebar" aria-label="Bots">
      <div className={cn("flex items-center gap-1 px-3 pt-3 pb-2", compactSidebar && "justify-center px-1")}>
        {!compactSidebar && (
          <span className="flex flex-1 items-center gap-2 text-[13px] font-semibold tracking-tight text-ink-2">
            <img
              src="/favicon.svg"
              alt=""
              width={20}
              height={20}
              className="rounded-[6px]"
              draggable={false}
            />
            FreeBird
          </span>
        )}
        <IconButton
          label={`New (${mod}N bot · ${mod}Shift+N group)`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom + 4, entries: plusEntries });
          }}
        >
          <Plus size={17} />
        </IconButton>
      </div>

      {!compactSidebar && (
        <div className="px-3 pb-2">
          <label className="flex h-8 items-center gap-2 rounded-lg bg-hover px-2.5 text-ink-3 focus-within:ring-2 focus-within:ring-accent">
            <Search size={14} aria-hidden="true" />
            <input
              id={BOT_SEARCH_ID}
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              onKeyDown={(event) => event.key === "Escape" && onQuery("")}
              placeholder="Search bots"
              aria-label="Search bots"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
            />
          </label>
        </div>
      )}

      <div className={cn("pb-1", compactSidebar ? "flex justify-center px-1" : "px-2")}>
        <button
          type="button"
          onClick={showLibrary}
          aria-current={view === "library" ? "page" : undefined}
          title="Library"
          className={cn(
            "flex h-8 items-center gap-2 rounded-lg text-[13px] text-ink-2 hover:bg-hover hover:text-ink",
            compactSidebar ? "w-8 justify-center" : "w-full px-2.5",
            view === "library" && "bg-selected text-ink",
          )}
        >
          <BookOpen size={15} aria-hidden="true" />
          {!compactSidebar && "Library"}
        </button>
      </div>

      <nav className={cn("min-h-0 flex-1 overflow-y-auto pb-2", compactSidebar ? "px-1" : "px-2")}>
        {isError && <p className="px-2 py-3 text-[13px] text-danger">Couldn't load bots.</p>}
        {notice &&
          (compactSidebar ? (
            <IconButton
              label={`${notice} (dismiss)`}
              onClick={() => notify(null)}
              className="mx-auto flex text-danger"
            >
              <AlertTriangle size={15} />
            </IconButton>
          ) : (
            <div role="alert" className="flex items-start gap-1 px-2 py-2 text-[13px] text-danger">
              <span className="min-w-0 flex-1">{notice}</span>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => notify(null)}
                className="rounded p-0.5 hover:bg-hover"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        {sections.map((section) =>
          section.name === null ? (
            section.bots.map(row)
          ) : (
            <div key={section.name} className="mt-2">
              {!compactSidebar && (
                <SectionHeader
                  label={section.name}
                  open={!collapsed.has(section.name)}
                  onToggle={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(section.name!)) next.delete(section.name!);
                      else next.add(section.name!);
                      return next;
                    })
                  }
                />
              )}
              {(compactSidebar || !collapsed.has(section.name)) && section.bots.map(row)}
            </div>
          ),
        )}
        {bots && visible.length === 0 && query && (
          <p className="px-2 py-3 text-[13px] text-ink-3">No bots match.</p>
        )}

        {[
          { label: "Races", threads: races, icon: <Flag size={14} /> },
          { label: "Clusters", threads: clusters, icon: <Network size={14} /> },
          { label: "Group chats", threads: groupChats, icon: <MessagesSquare size={14} /> },
        ].map(
          (section) =>
            section.threads.length > 0 && (
              <div key={section.label} className="mt-3">
                {!compactSidebar && <SectionHeader label={section.label} open onToggle={() => {}} fixed />}
                {section.threads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => select(thread.id)}
                    onContextMenu={(event) => open(event, groupEntries(thread))}
                    aria-current={thread.id === selectedThreadId ? "page" : undefined}
                    title={groupTitle(thread, botMap)}
                    className={cn(
                      "flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      thread.id === selectedThreadId ? "bg-selected" : "hover:bg-hover",
                      compactSidebar && "justify-center px-0",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-[26px] shrink-0 items-center justify-center rounded-lg",
                        thread.cluster ? "bg-selected text-accent" : "bg-hover text-ink-2",
                      )}
                    >
                      {section.icon}
                    </span>
                    {!compactSidebar && (
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
                        {groupTitle(thread, botMap)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ),
        )}

        {hidden.length > 0 && !compactSidebar && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShowHidden((value) => !value)}
              aria-expanded={showHidden}
              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-3 hover:bg-hover"
            >
              {showHidden ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              Hidden Bots ({hidden.length})
            </button>
            {showHidden && hidden.map(row)}
          </div>
        )}
      </nav>

      <div
        className={cn(
          "flex items-center border-t border-border py-2",
          compactSidebar ? "justify-center" : "px-2",
        )}
      >
        {!compactSidebar && (
          <div className="min-w-0 flex-1">
            <ConnectionStatus />
          </div>
        )}
        <IconButton label={`Settings (${mod},)`} onClick={() => openSettings("general")}>
          <Settings size={16} />
        </IconButton>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={closeMenu} />}
    </aside>
  );
}

function SectionHeader(props: { label: string; open: boolean; onToggle(): void; fixed?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onToggle}
      aria-expanded={props.fixed ? undefined : props.open}
      disabled={props.fixed}
      className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-3 hover:bg-hover disabled:hover:bg-transparent"
    >
      {!props.fixed && (props.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
      {props.label}
    </button>
  );
}
