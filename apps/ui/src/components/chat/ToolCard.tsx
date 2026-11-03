import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleSlash,
  Loader2,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";

import type { ApprovalDecision, MessagePart } from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { api } from "../../lib/api";
import { useUi } from "../../state";

type ToolPart = Extract<MessagePart, { type: "tool" }>;

const STATUS_ICON = {
  running: <Loader2 size={13} className="animate-spin" />,
  pending_approval: <Loader2 size={13} className="animate-spin" />,
  done: <Check size={13} className="text-success" />,
  error: <X size={13} className="text-danger" />,
  denied: <CircleSlash size={13} className="text-ink-3" />,
} as const;

/** A tool run in the transcript: an approval card while it waits, otherwise a collapsible chip. */
export function ToolCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  // ask_user shows as its own question card.
  if (part.name === "ask_user") return null;
  if (part.status === "pending_approval" && part.approval)
    return <ApprovalCard part={part} approval={part.approval} />;

  return (
    <div className="text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-ink-2 hover:text-ink"
      >
        {part.name === "run_command" ? (
          <SquareTerminal size={12} className="shrink-0" />
        ) : (
          <Wrench size={12} className="shrink-0" />
        )}
        <span className="truncate font-mono text-[12px]">{toolTitle(part)}</span>
        {STATUS_ICON[part.status]}
        <ChevronRight size={12} className={cn("shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-surface text-[12px]">
          <pre className="max-h-40 overflow-auto border-b border-border px-3 py-2 font-mono whitespace-pre-wrap text-ink-2 select-text">
            {JSON.stringify(part.args, null, 2)}
          </pre>
          <pre className="max-h-64 overflow-auto px-3 py-2 font-mono whitespace-pre-wrap select-text">
            {part.result ?? (part.status === "running" ? "Running…" : "")}
          </pre>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ part, approval }: { part: ToolPart; approval: NonNullable<ToolPart["approval"]> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openSettings = useUi((state) => state.openSettings);
  const terminal = approval.kind === "terminal";

  const decide = async (decision: ApprovalDecision) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/approvals/${approval.id}`, { method: "POST", body: { decision } });
    } catch (caught) {
      setError((caught as Error).message);
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-xl border border-accent/40 bg-surface p-3 text-[13px] shadow-sm"
      role="group"
      aria-label="Approval needed"
    >
      <div className="mb-2 flex items-center gap-2 font-medium">
        {terminal ? (
          <SquareTerminal size={15} className="text-accent" />
        ) : (
          <Wrench size={15} className="text-accent" />
        )}
        {terminal ? "Run this command?" : `Allow ${part.name.replaceAll("_", " ")}?`}
      </div>
      {terminal ? (
        <pre className="mb-2 overflow-x-auto rounded-lg bg-hover px-3 py-2 font-mono text-[12px] whitespace-pre-wrap select-text">
          {approval.summary}
        </pre>
      ) : (
        <p className="mb-2 break-all text-ink-2 select-text">{approval.summary}</p>
      )}
      {approval.badges.length > 0 && (
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {approval.badges.map((badge) => (
            <span
              key={badge}
              className="inline-flex items-center gap-1 rounded-md bg-warning/10 px-2 py-0.5 text-[11.5px] text-warning"
            >
              <AlertTriangle size={11} /> {badge}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {terminal ? (
          <>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide("allow_once")}>
              Allow
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void decide("deny")}>
              Skip
            </Button>
            <Button size="sm" variant="ghost" onClick={() => openSettings("computer")}>
              Manage settings
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide("allow_once")}>
              Allow once
            </Button>
            {approval.canAlways && (
              <Button size="sm" disabled={busy} onClick={() => void decide("always")}>
                Always allow
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide("deny")}>
              Deny
            </Button>
          </>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** Short human label for a tool call, e.g. `run_command: npm test`. */
function toolTitle(part: ToolPart): string {
  const first = Object.values(part.args).find((value) => typeof value === "string") as string | undefined;
  return first ? `${part.name}: ${first.length > 60 ? `${first.slice(0, 60)}…` : first}` : part.name;
}
