import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { Bot } from "@mrog/shared";
import { cn } from "@mrog/ui-kit";

import { botToolsKey, useUpdateBot } from "../../hooks/bots";
import { useSkillActions, useSkills } from "../../hooks/team";
import { canUseSkills, withSkills } from "../../lib/skills";
import { CodingSkills } from "./CodingSkills";
import { OwnSkills, SkillRow } from "./OwnSkills";

/**
 * The bot's skills: whether it can use them by itself, its own skills (for a Coding Bot: the whole team's and each
 * role's), and the ones shared by every bot (the built-in ones among them), folded away. Any skill can also be run by
 * typing /name in the chat.
 */
export function SkillsBlock({ bot }: { bot: Bot }) {
  const { data: skills } = useSkills(bot.id);
  const { remove } = useSkillActions();
  const update = useUpdateBot();
  const client = useQueryClient();
  const [sharedOpen, setSharedOpen] = useState(false);
  const shared = (skills ?? []).filter((skill) => skill.botId === null);
  const on = canUseSkills(bot);

  return (
    <section className="border-b border-border px-4 py-3.5">
      <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">Skills</h3>

      <label className="mb-2 flex cursor-pointer items-start gap-2 text-[13px]">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={on}
          disabled={update.isPending}
          onChange={(event) =>
            update.mutate(
              { id: bot.id, patch: { tools: withSkills(bot.tools, event.target.checked) } },
              { onSuccess: () => void client.invalidateQueries({ queryKey: botToolsKey(bot.id) }) },
            )
          }
        />
        <span>
          Can use skills
          <span className="block text-[12px] text-ink-3">
            {bot.coding
              ? "Its Planner, Developer and QA look up a skill when one fits their work, and follow it."
              : "It looks up a skill when one fits the task, and follows it. You can still run any skill with /name."}
          </span>
        </span>
      </label>

      {bot.coding ? (
        <CodingSkills bot={bot} />
      ) : (
        <OwnSkills ownerId={bot.id} empty="Add a skill of its own, or type / in the chat to run one." />
      )}

      {shared.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setSharedOpen((value) => !value)}
            aria-expanded={sharedOpen}
            className="flex items-center gap-1 text-[12.5px] text-ink-2"
          >
            <ChevronRight size={12} className={cn("transition-transform", sharedOpen && "rotate-90")} />
            Shared with every bot · {shared.length}
          </button>
          {sharedOpen && (
            <ul className="mt-1 flex max-h-72 flex-col gap-1 overflow-y-auto">
              {shared.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  onDelete={() =>
                    window.confirm(`Delete /${skill.name} for every bot?`) && remove.mutate(skill.id)
                  }
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
