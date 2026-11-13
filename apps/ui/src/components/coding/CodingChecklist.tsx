import { Check } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import type { CodingProject } from "@mrog/shared";
import { cn } from "@mrog/ui-kit";

import { buildChecklist } from "../../lib/codingChecklist";
import { emptyPlanText } from "../../lib/codingFeedback";
import { Chip } from "./parts";

/** Every file and every connector as a line, ticked once its card is Done. */
export function CodingChecklist({
  project,
  onPick,
}: {
  project: CodingProject;
  /** Picking a line shows its card on the board. */
  onPick(ref: string): void;
}) {
  const list = useMemo(() => buildChecklist(project), [project]);
  if (list.total === 0) {
    return (
      <p className="p-6 text-center text-[13px] text-ink-3">{emptyPlanText(project.status, "checklist")}</p>
    );
  }
  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <p className="text-[13px] font-medium" aria-live="polite">
        {list.summary}
      </p>
      <Group title="Files" done={list.filesDone} total={list.files.length}>
        {list.files.map((file) => (
          <Line key={file.id} done={file.done} onPick={() => onPick(file.id)}>
            <span className="truncate font-mono text-[12.5px]" title={file.path}>
              {file.path}
            </span>
            <span className="line-clamp-2 text-xs text-ink-3" title={file.purpose}>
              {file.purpose}
            </span>
          </Line>
        ))}
      </Group>
      <Group title="Connectors" done={list.connectorsDone} total={list.connectors.length}>
        {list.connectors.map((connector) => (
          <Line key={connector.id} done={connector.done} onPick={() => onPick(connector.id)}>
            <span className="flex items-center gap-1.5 text-[12.5px]">
              <Chip color="var(--mrog-ink-2)">{connector.label}</Chip>
              <span className="min-w-0 truncate" title={connector.description}>
                {connector.description}
              </span>
            </span>
            <span className="flex flex-wrap gap-x-2 font-mono text-[11.5px] text-ink-3">
              {connector.files.map((file) => (
                <span key={file.id}>{file.path}</span>
              ))}
            </span>
          </Line>
        ))}
      </Group>
    </div>
  );
}

function Group({
  title,
  done,
  total,
  children,
}: {
  title: string;
  done: number;
  total: number;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-2 text-[12.5px] font-semibold">
        {title}
        <span className="font-normal text-ink-3">
          {done} of {total} done
        </span>
      </h3>
      {total === 0 ? (
        <p className="text-xs text-ink-3">None in this plan.</p>
      ) : (
        <ul className="flex flex-col gap-1">{children}</ul>
      )}
    </section>
  );
}

function Line({ done, onPick, children }: { done: boolean; onPick(): void; children: ReactNode }) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span
          role="img"
          aria-label={done ? "Done" : "Not done yet"}
          className={cn(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
            done ? "border-success bg-success text-accent-ink" : "border-border bg-bg",
          )}
        >
          {done && <Check size={12} strokeWidth={3} aria-hidden />}
        </span>
        <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5", done && "text-ink-2")}>{children}</span>
      </button>
    </li>
  );
}
