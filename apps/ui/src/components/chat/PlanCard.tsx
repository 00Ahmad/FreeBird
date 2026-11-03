import { Check, Circle, ListChecks, Loader2 } from "lucide-react";

import type { MessagePart } from "@mrog/shared";
import { cn } from "@mrog/ui-kit";

type ToolPart = Extract<MessagePart, { type: "tool" }>;

interface PlanStep {
  step: string;
  status: "todo" | "doing" | "done";
}

/** The bot's checklist for a task, updated live as it works (from its update_plan calls). */
export function PlanCard({ part }: { part: ToolPart }) {
  const raw = (part.args as { steps?: unknown }).steps;
  const steps: PlanStep[] = Array.isArray(raw)
    ? raw.flatMap((item) =>
        typeof item === "string"
          ? [{ step: item, status: "todo" as const }]
          : item && typeof item === "object" && typeof (item as PlanStep).step === "string"
            ? [{ step: (item as PlanStep).step, status: (item as PlanStep).status ?? "todo" }]
            : [],
      )
    : [];
  if (steps.length === 0) return null;
  const finished = steps.filter((step) => step.status === "done").length;

  return (
    <div className="rounded-xl border border-border bg-surface px-3 py-2.5 text-[13px]" aria-label="Plan">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
        <ListChecks size={13} /> Plan · {finished} of {steps.length} done
      </div>
      <ol className="flex flex-col gap-1">
        {steps.map((step, index) => (
          <li key={index} className="flex items-start gap-2">
            {step.status === "done" ? (
              <Check size={14} className="mt-0.5 shrink-0 text-success" />
            ) : step.status === "doing" ? (
              <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-accent" />
            ) : (
              <Circle size={14} className="mt-0.5 shrink-0 text-ink-3" />
            )}
            <span className={cn(step.status === "done" && "text-ink-3 line-through")}>{step.step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
