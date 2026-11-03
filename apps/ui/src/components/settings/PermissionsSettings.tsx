import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import type { Permissions } from "@mrog/shared";
import { Button, cn, IconButton } from "@mrog/ui-kit";

import {
  useAddRule,
  useAgentSettings,
  useDeleteRule,
  usePermissions,
  useSaveAgentSettings,
  useSavePermissions,
} from "../../hooks/permissions";
import { Field, Section, TextInput } from "./parts";

/** Tools a rule can name; connectors and other sources add their own names later. */
const TOOL_NAMES = [
  "run_command",
  "write_file",
  "edit_file",
  "read_file",
  "list_files",
  "search_files",
  "fetch_url",
  "web_search",
  "browser_open",
  "browser_click",
  "browser_type",
];

const POLICIES: { value: Permissions["localExecution"]; label: string; hint: string }[] = [
  { value: "ask", label: "Ask every time", hint: "Each command shows a card you approve or skip." },
  { value: "always", label: "Always allow", hint: "Bots run commands on this computer without asking." },
  { value: "never", label: "Never allow", hint: "Bots can't run commands on this computer." },
];

export function ComputerSettings() {
  const { data: permissions } = usePermissions();
  const save = useSavePermissions();
  if (!permissions) return null;
  return (
    <div className="flex flex-col gap-6">
      <Section title="Execution on this computer" description="Applies to every bot's terminal commands.">
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Execution on this computer">
          {POLICIES.map((policy) => (
            <label
              key={policy.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5",
                permissions.localExecution === policy.value
                  ? "border-accent bg-selected"
                  : "border-border hover:bg-hover",
              )}
            >
              <input
                type="radio"
                name="local-execution"
                className="mt-1"
                checked={permissions.localExecution === policy.value}
                onChange={() => save.mutate({ ...permissions, localExecution: policy.value })}
              />
              <span>
                <span className="block text-[13.5px] font-medium">{policy.label}</span>
                <span className="block text-[12.5px] text-ink-3">{policy.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </Section>
    </div>
  );
}

const STEP_LIMITS = [10, 15, 25, 40, 60, 80];

/** How bots work through tasks: step budget, planning and self-checks. */
function WorkSettings() {
  const { data: settings } = useAgentSettings();
  const save = useSaveAgentSettings();
  if (!settings) return null;
  return (
    <Section
      title="How bots work"
      description="Applies to every bot. More steps and checks give better answers on hard tasks, at the cost of time."
    >
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={settings.planning}
          onChange={(event) => save.mutate({ ...settings, planning: event.target.checked })}
        />
        Plan first: for tasks with several steps, the bot shows a checklist and ticks it off
      </label>
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={settings.selfCheck}
          onChange={(event) => save.mutate({ ...settings, selfCheck: event.target.checked })}
        />
        Double-check answers: after a task that used tools, the bot checks its answer against your request
        once
      </label>
      <Field
        label="Steps per reply"
        hint="Tool steps a bot may take before it stops and reports what it has."
      >
        <select
          className="select max-w-48"
          value={settings.maxSteps}
          onChange={(event) => save.mutate({ ...settings, maxSteps: Number(event.target.value) })}
        >
          {STEP_LIMITS.map((limit) => (
            <option key={limit} value={limit}>
              {limit} steps
            </option>
          ))}
        </select>
      </Field>
    </Section>
  );
}

export function GeneralSettings() {
  const { data: permissions } = usePermissions();
  const add = useAddRule();
  const remove = useDeleteRule();
  const [tool, setTool] = useState(TOOL_NAMES[1]!);
  const [match, setMatch] = useState("");
  const [decision, setDecision] = useState<"allow" | "ask">("allow");
  if (!permissions) return null;

  return (
    <div className="flex flex-col gap-6">
      <WorkSettings />
      <Section
        title="Custom Rules"
        description="Decide in advance what bots may do without asking. Commands also follow the Computer setting."
      >
        {permissions.rules.length === 0 ? (
          <p className="text-[13px] text-ink-3">No rules yet. Choosing “Always allow” on a card adds one.</p>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="text-[12px] text-ink-3">
              <tr>
                <th className="py-1 font-medium">When a bot wants to</th>
                <th className="py-1 font-medium">Matching</th>
                <th className="py-1 font-medium">It should</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {permissions.rules.map((rule) => (
                <tr key={rule.id} className="border-t border-border">
                  <td className="py-2 font-mono text-[12px]">{rule.tool}</td>
                  <td className="py-2 text-ink-2">{rule.match ?? "anything"}</td>
                  <td className="py-2">{rule.decision === "allow" ? "Allow automatically" : "Ask first"}</td>
                  <td className="py-2 text-right">
                    <IconButton label="Delete rule" onClick={() => remove.mutate(rule.id)}>
                      <Trash2 size={14} />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form
          className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate({ tool, match: match.trim() || null, decision }, { onSuccess: () => setMatch("") });
          }}
        >
          <Field label="When a bot wants to">
            <select className="select" value={tool} onChange={(event) => setTool(event.target.value)}>
              {TOOL_NAMES.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </Field>
          <Field label="Starting with (optional)">
            <TextInput
              value={match}
              onChange={(event) => setMatch(event.target.value)}
              placeholder="e.g. git status"
            />
          </Field>
          <Field label="It should">
            <select
              className="select"
              value={decision}
              onChange={(event) => setDecision(event.target.value as "allow" | "ask")}
            >
              <option value="allow">Allow automatically</option>
              <option value="ask">Ask first</option>
            </select>
          </Field>
          <Button type="submit" size="md" disabled={add.isPending}>
            <Plus size={14} /> Add Rule
          </Button>
        </form>
        {add.error && <p className="text-xs text-danger">{add.error.message}</p>}
      </Section>
    </div>
  );
}
