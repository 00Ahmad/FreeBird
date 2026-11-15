import { Columns3, Wrench } from "lucide-react";

import { cn, IconButton } from "@mrog/ui-kit";

import {
  parallelSwitchTip,
  toolsSwitchTip,
  TOOLS_SWITCH_LABEL,
  type ToolsChoice,
} from "../../lib/parallelLanes";

/**
 * The composer's Parallel Bots switch: one message, three roles' answers. On a local model they come in one reply with
 * three sections; on a cloud model (by default) or with tools, each role is asked separately.
 */
export function ParallelToggle({ on, onToggle }: { on: boolean; onToggle(): void }) {
  return (
    <IconButton
      label={parallelSwitchTip(on)}
      aria-pressed={on}
      onClick={onToggle}
      className={cn(on && "bg-selected text-accent")}
    >
      <Columns3 size={16} />
    </IconButton>
  );
}

/**
 * Next to the Parallel switch, only while it is on: let each of the three roles search the web on its own. Off, with the
 * reason, when the bot can't (a Visual Bot, or web search and page fetching both turned off).
 */
export function ToolsToggle({
  on,
  choice,
  onToggle,
}: {
  on: boolean;
  choice: ToolsChoice;
  onToggle(): void;
}) {
  const active = on && choice.ok;
  return (
    <IconButton
      label={toolsSwitchTip(choice, active)}
      role="switch"
      aria-checked={active}
      aria-disabled={!choice.ok}
      disabled={!choice.ok}
      onClick={onToggle}
      className={cn("w-auto gap-1.5 px-2 text-[12px]", active && "bg-selected text-accent")}
    >
      <Wrench size={14} />
      <span>{TOOLS_SWITCH_LABEL}</span>
    </IconButton>
  );
}
