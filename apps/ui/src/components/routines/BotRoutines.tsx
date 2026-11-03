import { Plus } from "lucide-react";
import { useState } from "react";

import type { Bot } from "@mrog/shared";
import { IconButton } from "@mrog/ui-kit";

import { useRoutines } from "../../hooks/phase5";
import { RoutineEditor } from "./RoutineEditor";
import { RoutineRow, useRoutineMenu } from "./RoutinesSettings";

/** A bot's routines in its details pane; right-click for Pause, Resume, Test, Edit, Delete. */
export function BotRoutines({ bot }: { bot: Bot }) {
  const { data: routines } = useRoutines(bot.id);
  const menu = useRoutineMenu();
  const [creating, setCreating] = useState(false);
  return (
    <section className="border-b border-border px-4 py-3.5">
      <div className="mb-2 flex items-center">
        <h3 className="flex-1 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">Routines</h3>
        <IconButton label="New routine" onClick={() => setCreating(true)}>
          <Plus size={14} />
        </IconButton>
      </div>
      {routines?.length === 0 && (
        <p className="text-[12.5px] text-ink-3">
          Have it do something on a schedule or when a webhook fires.
        </p>
      )}
      <ul className="flex flex-col gap-1.5">
        {routines?.map((routine) => (
          <RoutineRow key={routine.id} routine={routine} onMenu={(event) => menu.open(event, routine)} />
        ))}
      </ul>
      {menu.elements}
      {creating && <RoutineEditor botId={bot.id} onClose={() => setCreating(false)} />}
    </section>
  );
}
