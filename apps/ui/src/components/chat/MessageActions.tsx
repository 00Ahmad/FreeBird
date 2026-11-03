import { Bookmark, BookmarkCheck, Check, Copy, CornerUpLeft, FileDown, SmilePlus } from "lucide-react";
import { useState } from "react";

import { libraryTitle, messageText, REACTIONS, type Bot, type Message } from "@mrog/shared";
import { cn } from "@mrog/ui-kit";

import { useLibraryActions } from "../../hooks/library";
import { useReact } from "../../hooks/team";
import { downloadText, fileName } from "../../lib/export";
import { ReadAloud } from "../voice/VoiceButton";

/** Hover toolbar under a message: reply in thread, react, copy. Reactions only acknowledge (UI-SPEC §5). */
export function MessageActions({
  message,
  saved: inLibrary,
  onReply,
  align,
}: {
  message: Message;
  /** Already in the Library. */
  saved: boolean;
  onReply(): void;
  align: "start" | "end";
}) {
  const react = useReact();
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const library = useLibraryActions();
  const button =
    "inline-flex size-6 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink";

  return (
    <div className={cn("mt-1 flex flex-wrap items-center gap-1", align === "end" && "justify-end")}>
      {message.reactions.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => react.mutate({ messageId: message.id, emoji })}
          className="rounded-full border border-border bg-surface px-1.5 text-[13px] leading-5 hover:bg-hover"
          aria-label={`Remove ${emoji}`}
        >
          {emoji}
        </button>
      ))}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button type="button" className={button} aria-label="Reply" title="Reply" onClick={onReply}>
          <CornerUpLeft size={13} />
        </button>
        <div className="relative">
          <button
            type="button"
            className={button}
            aria-label="React"
            title="React"
            onClick={() => setPicking((value) => !value)}
          >
            <SmilePlus size={13} />
          </button>
          {picking && (
            <div className="absolute bottom-full left-0 z-20 mb-1 flex gap-0.5 rounded-full border border-border bg-surface px-1.5 py-1 shadow-pop">
              {REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="rounded-full px-1 text-[15px] hover:bg-hover"
                  onClick={() => {
                    react.mutate({ messageId: message.id, emoji });
                    setPicking(false);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
        {message.role === "bot" && <ReadAloud text={messageText(message)} />}
        {message.role === "bot" && (
          <>
            <button
              type="button"
              className={button}
              aria-label={inLibrary ? "Saved to Library" : "Save to Library"}
              title={inLibrary ? "Saved to Library" : "Save to Library"}
              disabled={inLibrary || library.save.isPending}
              onClick={() => library.save.mutate(message.id)}
            >
              {inLibrary ? <BookmarkCheck size={13} className="text-accent" /> : <Bookmark size={13} />}
            </button>
            <button
              type="button"
              className={button}
              aria-label="Download as Markdown"
              title="Download as Markdown"
              onClick={() => {
                const text = messageText(message);
                downloadText(fileName(libraryTitle(text), "md"), text, "text/markdown;charset=utf-8");
              }}
            >
              <FileDown size={13} />
            </button>
          </>
        )}
        <button
          type="button"
          className={button}
          aria-label="Copy"
          title="Copy"
          onClick={() => {
            const done = (result: "copied" | "failed") => {
              setCopied(result);
              setTimeout(() => setCopied(null), result === "copied" ? 1200 : 2500);
            };
            navigator.clipboard.writeText(messageText(message)).then(
              () => done("copied"),
              () => done("failed"),
            );
          }}
        >
          {copied === "copied" ? <Check size={13} /> : <Copy size={13} />}
        </button>
        {copied === "failed" && <span className="text-xs text-danger">Couldn't copy</span>}
      </div>
    </div>
  );
}

/** The message this one replies to, shown small above it. */
export function ReplyQuote({ original, bots }: { original: Message | undefined; bots: Map<string, Bot> }) {
  if (!original) return null;
  const who = original.botId ? (bots.get(original.botId)?.name ?? "Bot") : "You";
  return (
    <div className="mb-1 flex max-w-full items-center gap-1.5 border-l-2 border-border pl-2 text-[12px] text-ink-3">
      <CornerUpLeft size={11} className="shrink-0" />
      <span className="shrink-0 font-medium">{who}</span>
      <span className="truncate">{messageText(original)}</span>
    </div>
  );
}
