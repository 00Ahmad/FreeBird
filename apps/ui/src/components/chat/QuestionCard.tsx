import { Check, HelpCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { MessagePart } from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { api } from "../../lib/api";
import { answerBody, answerLines, togglePick, type AnswerBody } from "../../lib/question";
import { COMPOSER_ID } from "./Composer";

type QuestionPart = Extract<MessagePart, { type: "question" }>;

/**
 * A question from a bot. With choices, one tap answers (or ticks, for several); typing something else is always
 * possible. Without, a single line to answer in.
 */
export function QuestionCard({ part, live }: { part: QuestionPart; live: boolean }) {
  const [typed, setTyped] = useState("");
  const [picks, setPicks] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const firstOption = useRef<HTMLButtonElement>(null);
  const options = part.options ?? [];
  const multiple = Boolean(part.multiple) && options.length > 0;
  const waiting = part.answer === undefined && !part.expired && live;

  // Keyboard users land on the first choice, but only when nothing is in use: a question that arrives while the user
  // is typing must not take focus, or their next Enter or Space would answer it.
  const offered = useRef(false);
  useEffect(() => {
    if (offered.current || !waiting || options.length === 0) return;
    offered.current = true; // once, when the card appears
    const current = document.activeElement as HTMLElement | null;
    const idle =
      !current ||
      current === document.body ||
      (current.id === COMPOSER_ID && (current as HTMLTextAreaElement).value === "");
    if (idle) firstOption.current?.focus();
  }, [waiting, options.length]);

  const submit = async (body: AnswerBody | null) => {
    if (!body || sending) return;
    // Asked before anything changes: the button just pressed is disabled while sending, which drops focus to the page.
    const keyboardWasHere = Boolean(card.current?.contains(document.activeElement));
    setSending(true);
    setError(null);
    try {
      await api(`/questions/${part.questionId}`, { method: "POST", body });
      // The card was where the keyboard was; the conversation goes on in the message box.
      if (keyboardWasHere) document.getElementById(COMPOSER_ID)?.focus();
    } catch (caught) {
      setError((caught as Error).message);
      setSending(false);
    }
  };

  return (
    <div ref={card} className="rounded-xl border border-border bg-surface p-3 text-[13px]">
      <div className="flex items-start gap-2">
        <HelpCircle size={15} className="mt-0.5 shrink-0 text-accent" />
        <p className="font-medium select-text">{part.question}</p>
      </div>

      {part.answer !== undefined ? (
        <AnswerLines part={part} />
      ) : part.expired ? (
        <p className="mt-1.5 pl-6 text-ink-3">No longer waiting for an answer.</p>
      ) : !live ? (
        <p className="mt-1.5 pl-6 text-ink-3">Not answered.</p>
      ) : (
        <div className="mt-2 pl-6">
          {options.length > 0 && (
            <div
              role={multiple ? "group" : "list"}
              aria-label={multiple ? "Choose any number" : "Choose one"}
              className="flex flex-col gap-1.5"
            >
              {options.map((option, index) => {
                const on = picks.includes(option);
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={sending}
                    ref={index === 0 ? firstOption : undefined}
                    role={multiple ? "checkbox" : undefined}
                    aria-checked={multiple ? on : undefined}
                    onClick={() =>
                      multiple
                        ? setPicks((current) => togglePick(options, current, option))
                        : void submit(answerBody({ picks: [option], typed: "", multiple: false }))
                    }
                    className={cn(
                      "flex min-h-8 items-center gap-2 rounded-lg border px-3 py-1.5 text-left select-text outline-none",
                      "focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60",
                      on ? "border-accent bg-selected" : "border-border bg-bg hover:bg-hover",
                    )}
                  >
                    {multiple && (
                      <span
                        aria-hidden
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded border",
                          on ? "border-accent bg-accent text-accent-ink" : "border-ink-3",
                        )}
                      >
                        {on && <Check size={11} strokeWidth={3} />}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">{option}</span>
                  </button>
                );
              })}
            </div>
          )}

          <form
            className={cn("flex gap-2", options.length > 0 && "mt-2")}
            onSubmit={(event) => {
              event.preventDefault();
              void submit(answerBody({ picks: multiple ? picks : [], typed, multiple }));
            }}
          >
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={options.length > 0 ? "Or write your own answer" : "Your answer"}
              aria-label={options.length > 0 ? "Or write your own answer" : "Your answer"}
              autoFocus={options.length === 0}
              maxLength={4000}
              className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 outline-none focus:border-accent"
            />
            <Button
              size="sm"
              variant="primary"
              type="submit"
              disabled={sending || !answerBody({ picks: multiple ? picks : [], typed, multiple })}
            >
              {multiple ? "Send" : "Answer"}
            </Button>
          </form>
        </div>
      )}
      {error && <p className="mt-1.5 pl-6 text-xs text-danger">{error}</p>}
      {waiting && multiple && picks.length > 0 && (
        <p className="mt-1.5 pl-6 text-xs text-ink-3" aria-live="polite">
          {picks.length} chosen
        </p>
      )}
    </div>
  );
}

function AnswerLines({ part }: { part: QuestionPart }) {
  const lines = answerLines(part);
  if (lines.length <= 1)
    return <p className="mt-1.5 pl-6 text-ink-2 select-text">You: {lines[0] ?? part.answer}</p>;
  return (
    <ul className="mt-1.5 list-disc pl-10 text-ink-2 select-text">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
