import { BookOpen, FileDown, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import type { LibraryItem } from "@mrog/shared";
import { cn, IconButton } from "@mrog/ui-kit";

import { useLibrary, useLibraryActions } from "../hooks/library";
import { useThreads } from "../hooks/threads";
import { downloadText, fileName } from "../lib/export";
import { useUi } from "../state";
import { Markdown } from "./chat/Markdown";

/** Replies you saved: reports, tables and answers you'll want again, kept even if their chat is cleared. */
export function LibraryView() {
  const { data: items, isPending } = useLibrary();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items?.find((item) => item.id === selectedId) ?? items?.[0] ?? null;

  return (
    <main className="flex h-full min-h-0 bg-bg">
      <section className="flex w-72 shrink-0 flex-col border-r border-border" aria-label="Saved replies">
        <header className="flex items-center gap-2 px-4 pt-4 pb-3">
          <BookOpen size={16} className="text-ink-2" />
          <h1 className="text-[15px] font-semibold">Library</h1>
        </header>
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {!isPending && items?.length === 0 && (
            <li className="px-2 py-3 text-[13px] text-ink-3">
              Nothing saved yet. Hover a bot's reply and click the bookmark to keep it here.
            </li>
          )}
          {items?.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setSelectedId(item.id)}
                className={cn(
                  "flex w-full flex-col items-start rounded-lg px-2.5 py-2 text-left",
                  selected?.id === item.id ? "bg-selected" : "hover:bg-hover",
                )}
              >
                <span className="w-full truncate text-[13.5px] font-medium">{item.title}</span>
                <span className="text-[11.5px] text-ink-3">
                  {item.botName ?? "Bot"} · {new Date(item.createdAt).toLocaleDateString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {selected ? <LibraryItemView key={selected.id} item={selected} /> : <div className="flex-1" />}
    </main>
  );
}

function LibraryItemView({ item }: { item: LibraryItem }) {
  const actions = useLibraryActions();
  const { data: threads } = useThreads();
  const select = useUi((state) => state.select);
  const [editing, setEditing] = useState(false);
  const chatExists = threads?.some((thread) => thread.id === item.threadId) ?? false;

  return (
    <article className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-5 py-3">
        {editing ? (
          <form
            className="flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
              if (title) actions.rename.mutate({ id: item.id, title });
              setEditing(false);
            }}
          >
            <input
              name="title"
              defaultValue={item.title}
              autoFocus
              onBlur={(event) => event.currentTarget.form?.requestSubmit()}
              className="h-8 w-full rounded-lg border border-border bg-bg px-2.5 text-[14px] outline-none focus:border-accent"
              aria-label="Title"
            />
          </form>
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{item.title}</h2>
        )}
        <IconButton label="Rename" onClick={() => setEditing(true)}>
          <Pencil size={14} />
        </IconButton>
        {chatExists && item.threadId && (
          <IconButton label="Open the chat it came from" onClick={() => select(item.threadId)}>
            <MessageSquare size={14} />
          </IconButton>
        )}
        <IconButton
          label="Download as Markdown"
          onClick={() => downloadText(fileName(item.title, "md"), item.text, "text/markdown;charset=utf-8")}
        >
          <FileDown size={14} />
        </IconButton>
        <IconButton label="Remove from Library" onClick={() => actions.remove.mutate(item.id)}>
          <Trash2 size={14} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[14.5px] select-text">
        <Markdown text={item.text} />
      </div>
    </article>
  );
}
