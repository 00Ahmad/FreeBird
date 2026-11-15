import { Cable, FileCode } from "lucide-react";
import type { ReactNode } from "react";

import type { CardComment, CodingCard, CodingColumn } from "@mrog/shared";
import { cn } from "@mrog/ui-kit";

import {
  COLUMN_COLOR,
  columnLabel,
  lastFailureIndex,
  needsFixing,
  sortComments,
} from "../../lib/codingBoard";

/** A colour mixed into the surface, for tinted backgrounds that stay readable in light and dark. */
export const tint = (color: string, percent: number) =>
  `color-mix(in srgb, ${color} ${percent}%, var(--mrog-surface))`;

export function Chip({ color, children, title }: { color: string; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[11px] leading-4 font-medium"
      style={{ color, background: tint(color, 16), border: `1px solid ${tint(color, 35)}` }}
    >
      {children}
    </span>
  );
}

export function ColumnChip({ column }: { column: CodingColumn }) {
  return <Chip color={COLUMN_COLOR[column]}>{columnLabel(column)}</Chip>;
}

export function KindBadge({ kind }: { kind: CodingCard["kind"] }) {
  const Icon = kind === "file" ? FileCode : Cable;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-hover px-1.5 py-px text-[11px] font-medium text-ink-2">
      <Icon size={11} aria-hidden /> {kind === "file" ? "File" : "Connector"}
    </span>
  );
}

const AUTHOR: Record<CardComment["author"], { label: string; color: string }> = {
  planner: { label: "Planner", color: "var(--mrog-avatar-violet)" },
  developer: { label: "Developer", color: "var(--mrog-avatar-sky)" },
  qa: { label: "QA", color: "var(--mrog-warning)" },
  user: { label: "You", color: "var(--mrog-accent)" },
};

/** A card's comments, oldest first so the newest is last. QA's on a card sent back stand out. */
export function Comments({ card, className }: { card: CodingCard; className?: string }) {
  const comments = sortComments(card.comments);
  if (comments.length === 0) return null;
  const fixing = needsFixing(card);
  // The finding to fix, not a pass or a "back in QA" note that came after it.
  const lastQa = lastFailureIndex({ column: card.column, comments });
  return (
    <ul className={cn("flex flex-col gap-1.5", className)} aria-label="Comments">
      {comments.map((comment, index) => {
        const author = AUTHOR[comment.author];
        const sentBack = fixing && index === lastQa;
        return (
          <li
            key={`${comment.at}-${index}`}
            className="rounded-md border-l-2 bg-bg px-2 py-1.5"
            style={{
              borderLeftColor: sentBack ? "var(--mrog-danger)" : author.color,
              ...(sentBack ? { background: tint("var(--mrog-danger)", 10) } : {}),
            }}
          >
            <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-ink-3">
              <Chip color={author.color}>{author.label}</Chip>
              <span title={new Date(comment.at).toLocaleString()}>Round {comment.round}</span>
              {sentBack && <span className="font-medium text-danger">needs fixing</span>}
            </div>
            <p className="select-text text-[12.5px] leading-snug break-words whitespace-pre-wrap text-ink">
              {comment.text}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
