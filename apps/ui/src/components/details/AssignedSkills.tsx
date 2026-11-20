import { X } from "lucide-react";

import { useAssignedSkills, useSetAssignedSkills } from "../../hooks/assignedSkills";
import { useSkills } from "../../hooks/team";

/**
 * The skills a role applies on every card, picked from the ones it has (the shared ones, the built-in 40 among
 * them): shown as chips you can remove, with a menu to add another.
 */
export function AssignedSkills({ botId }: { botId: string }) {
  const { data: assigned } = useAssignedSkills(botId);
  const { data: skills } = useSkills(botId);
  const save = useSetAssignedSkills(botId);
  const names = assigned?.names ?? [];
  const has = (name: string) => names.some((other) => other.toLowerCase() === name.toLowerCase());
  const known = new Set((skills ?? []).map((skill) => skill.name.toLowerCase()));
  const choices = (skills ?? []).filter((skill) => !has(skill.name));

  return (
    <div className="mb-1">
      <p className="text-[12px] text-ink-3">
        Applies on every card{assigned?.defaults ? " (the defaults)" : ""}:
      </p>
      <ul className="mt-1 flex flex-wrap gap-1">
        {names.length === 0 && <li className="text-[12.5px] text-ink-3">None.</li>}
        {names.map((name) => (
          <li
            key={name}
            className="flex items-center gap-0.5 rounded-full border border-border py-0.5 pr-1 pl-2 font-mono text-[12px]"
            title={
              known.has(name.toLowerCase()) ? undefined : "This skill no longer exists, so it isn't used."
            }
          >
            <span className={known.has(name.toLowerCase()) ? "text-accent" : "text-ink-3 line-through"}>
              {name}
            </span>
            <button
              type="button"
              aria-label={`Stop applying ${name}`}
              disabled={save.isPending}
              onClick={() => save.mutate(names.filter((other) => other !== name))}
              className="rounded-full p-0.5 hover:bg-hover"
            >
              <X size={11} />
            </button>
          </li>
        ))}
      </ul>
      {choices.length > 0 && (
        <select
          aria-label="Apply another skill"
          value=""
          disabled={save.isPending}
          onChange={(event) => event.target.value && save.mutate([...names, event.target.value])}
          className="mt-1.5 h-7 w-full rounded-lg border border-border bg-bg px-1.5 text-[12.5px]"
        >
          <option value="">Apply another skill…</option>
          {choices.map((skill) => (
            <option key={skill.id} value={skill.name}>
              {skill.name}
            </option>
          ))}
        </select>
      )}
      {save.error && <p className="text-xs text-danger">{save.error.message}</p>}
    </div>
  );
}
