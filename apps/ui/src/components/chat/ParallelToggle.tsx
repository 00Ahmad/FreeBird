import { Columns3 } from "lucide-react";

import { cn, IconButton } from "@mrog/ui-kit";

/** The composer's Parallel Bots switch: one request, one reply with three roles' answers in three sections. */
export function ParallelToggle({ on, onToggle }: { on: boolean; onToggle(): void }) {
  return (
    <IconButton
      label={
        on
          ? "Parallel Bots is on: one request, three answers. Click to turn it off"
          : "Parallel Bots: ask once and get three answers from three roles"
      }
      aria-pressed={on}
      onClick={onToggle}
      className={cn(on && "bg-selected text-accent")}
    >
      <Columns3 size={16} />
    </IconButton>
  );
}
