import { Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { Skill } from "@mrog/shared";
import { Button, cn, IconButton } from "@mrog/ui-kit";

import { useSkillActions, useSkills } from "../../hooks/team";

const field = "rounded-lg border border-border bg-bg px-2 text-[12.5px] outline-none focus:border-accent";

export function SkillRow({ skill, onDelete }: { skill: Skill; onDelete(): void }) {
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
 * The skills one bot owns (not the shared ones), with a form to add one. `title` names a part of a team (a Coding
 * Bot's whole team, or one of its roles); `empty` is what shows when it has none yet.
 */
export function OwnSkills({
  ownerId,
  title,
  empty,
  children,
}: {
  ownerId: string;
  title?: string;
  empty: string;
  /** Shown under the title, before the list (a role's assigned skills). */
  children?: ReactNode;
}) {
  const { data: skills } = useSkills(ownerId);
  const { add, remove } = useSkillActions();
  const [form, setForm] = useState<{ name: string; description: string; prompt: string } | null>(null);
  const own = (skills ?? []).filter((skill) => skill.botId === ownerId);
  const addLabel = title ? `Add skill for ${title}` : "Add skill";

  return (
    <div className={cn(title && "mt-2.5")}>
      <div className="mb-1 flex items-center">
        {title ? (
          <h4 className="flex-1 text-[12.5px] font-medium text-ink-2">{title}</h4>
        ) : (
          <span className="flex-1" />
        )}
        <IconButton label={addLabel} onClick={() => setForm({ name: "", description: "", prompt: "" })}>
          <Plus size={14} />
        </IconButton>
      </div>

      {children}
      {own.length === 0 && !form && <p className="text-[12.5px] text-ink-3">{empty}</p>}
      <ul className="flex flex-col gap-1">
        {own.map((skill) => (
          <SkillRow key={skill.id} skill={skill} onDelete={() => remove.mutate(skill.id)} />
        ))}
      </ul>

      {form && (
        <form
          className="mt-2 flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate(
              {
                botId: ownerId,
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
    </div>
  );
}
