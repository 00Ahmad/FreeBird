import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { Bot, Skill } from "@mrog/shared";
import { Button, cn, IconButton } from "@mrog/ui-kit";

import { botToolsKey, useUpdateBot } from "../../hooks/bots";
import { useSkillActions, useSkills } from "../../hooks/team";
import { canUseSkills, withSkills } from "../../lib/skills";

const field = "rounded-lg border border-border bg-bg px-2 text-[12.5px] outline-none focus:border-accent";

function SkillRow({ skill, onDelete }: { skill: Skill; onDelete(): void }) {
  return (
    <li className="group flex items-start gap-2 text-[13px]">
      <span className="shrink-0 font-mono text-[12px] text-accent">/{skill.name}</span>
      <span className="min-w-0 flex-1 truncate text-ink-3" title={skill.prompt}>
        {skill.description || skill.prompt}
      </span>
      <IconButton
        label={`Delete ${skill.name}`}
        className="size-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
        onClick={onDelete}
      >
        <Trash2 size={12} />
      </IconButton>
    </li>
  );
}

/**
 * The bot's skills: whether it can use them by itself, its own skills, and the ones shared by every bot (the built-in
 * ones among them), folded away. Any skill can also be run by typing /name in the chat.
 */
export function SkillsBlock({ bot }: { bot: Bot }) {
  const { data: skills } = useSkills(bot.id);
  const { add, remove } = useSkillActions();
  const update = useUpdateBot();
  const client = useQueryClient();
  const [form, setForm] = useState<{ name: string; description: string; prompt: string } | null>(null);
  const [sharedOpen, setSharedOpen] = useState(false);
  const own = (skills ?? []).filter((skill) => skill.botId === bot.id);
  const shared = (skills ?? []).filter((skill) => skill.botId === null);
  const on = canUseSkills(bot);

  return (
    <section className="border-b border-border px-4 py-3.5">
      <div className="mb-2 flex items-center">
        <h3 className="flex-1 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">Skills</h3>
        <IconButton label="Add skill" onClick={() => setForm({ name: "", description: "", prompt: "" })}>
          <Plus size={14} />
        </IconButton>
      </div>

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

      {own.length === 0 && !form && (
        <p className="text-[12.5px] text-ink-3">Add a skill of its own, or type / in the chat to run one.</p>
      )}
      <ul className="flex flex-col gap-1">
        {own.map((skill) => (
          <SkillRow key={skill.id} skill={skill} onDelete={() => remove.mutate(skill.id)} />
        ))}
      </ul>

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

      {form && (
        <form
          className="mt-2 flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate(
              {
                botId: bot.id,
                name: form.name.trim(),
                prompt: form.prompt.trim(),
                description: form.description.trim(),
              },
              { onSuccess: () => setForm(null) },
            );
          }}
        >
          <input
            autoFocus
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="name (e.g. standup)"
            aria-label="Skill name"
            className={cn(field, "h-8 font-mono")}
          />
          <input
            value={form.description}
            maxLength={400}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            placeholder="When to use it (the bot reads this to pick it)"
            aria-label="When to use the skill"
            className={cn(field, "h-8")}
          />
          <textarea
            value={form.prompt}
            onChange={(event) => setForm({ ...form, prompt: event.target.value })}
            rows={3}
            placeholder="The steps: what to do, in order"
            aria-label="Skill prompt"
            className={cn(field, "py-1.5")}
          />
          {add.error && <p className="text-xs text-danger">{add.error.message}</p>}
          <div className="flex gap-1.5">
            <Button
              size="sm"
              type="submit"
              variant="primary"
              disabled={!form.name.trim() || !form.prompt.trim()}
            >
              Save skill
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
