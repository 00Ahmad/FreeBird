import { memo, useMemo } from "react";

import { PARALLEL_SECTIONS, parseParallel } from "@mrog/shared";
import { cn } from "@mrog/ui-kit";

import { Markdown } from "./Markdown";

/**
 * The three answers of a Parallel Bots reply, side by side, filling in as the one reply is written. A reply that
 * didn't come out in sections is shown as it is, and anything outside the sections stays above them, so no text is
 * ever hidden.
 */
export const ParallelCards = memo(function ParallelCards({
  text,
  streaming,
  done,
}: {
  text: string;
  streaming: boolean;
  /** The reply finished normally (not stopped or failed): only then does a short one get a note. */
  done: boolean;
}) {
  const { before, sections } = useMemo(() => parseParallel(text), [text]);
  // While the reply is being written, one section is enough to start laying the cards out; once it's done a reply
  // needs at least two to count as sections at all.
  const asCards = sections.length >= 2 || (streaming && sections.length >= 1);
  // Only a new question gets a fresh reply: a finished one has no Try again.
  const note =
    done && sections.length < PARALLEL_SECTIONS && text.trim()
      ? `${
          sections.length === 0
            ? "The model didn't answer in sections."
            : `The model wrote ${sections.length} of ${PARALLEL_SECTIONS} sections.`
        } Send your question again for a fresh reply.`
      : null;
  if (!asCards) {
    return (
      <div className="flex flex-col gap-2">
        <Markdown text={text} />
        {note && <p className="text-xs text-ink-3">{note}</p>}
      </div>
    );
  }

  const waiting = streaming ? PARALLEL_SECTIONS - sections.length : 0;
  return (
    <div className="flex flex-col gap-2">
      {before && <Markdown text={before} />}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(12.5rem,1fr))] gap-2">
        {sections.map((section) => (
          <section
            key={section.index}
            aria-label={section.role || `Bot ${section.index}`}
            className="min-w-0 rounded-xl border border-border bg-surface px-3 py-2.5"
          >
            <h4 className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-selected text-[11px] text-ink-2">
                {section.index}
              </span>
              <span className="min-w-0 truncate">{section.role || `Bot ${section.index}`}</span>
            </h4>
            <div
              className={cn(
                "select-text",
                streaming && section.index === sections.length && "streaming-caret",
              )}
            >
              <Markdown text={section.text} />
            </div>
          </section>
        ))}
        {Array.from({ length: waiting }, (_, at) => (
          <div
            key={`waiting-${at}`}
            aria-hidden
            className="rounded-xl border border-dashed border-border px-3 py-2.5 text-[13px] text-ink-3"
          >
            Bot {sections.length + at + 1} is next…
          </div>
        ))}
      </div>
      {note && <p className="text-xs text-ink-3">{note}</p>}
    </div>
  );
});
