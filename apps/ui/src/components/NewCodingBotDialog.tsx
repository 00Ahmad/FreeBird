import { CodeXml, FolderOpen, Loader2 } from "lucide-react";
import { useState } from "react";

import { MAX_ROUNDS_LIMIT } from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { useCreateCodingBot } from "../hooks/coding";
import { codingFormProblem, codingInput, DEFAULT_CODING_FORM, type CodingForm } from "../lib/coding";
import { useUi } from "../state";
import { Switch } from "./coding/Switch";
import { Modal } from "./Modal";
import { ModelSelect } from "./ModelSelect";

const field = "rounded-lg border border-border bg-bg px-2.5 text-[13px] outline-none focus:border-accent";

const ROLES = [
  { key: "planner", name: "Planner", does: "Reads your brief and draws the files and how they connect." },
  { key: "developer", name: "Developer", does: "Writes the code, one file or connection at a time." },
  { key: "qa", name: "QA", does: "Checks every file and connection, and sends back what is wrong." },
] as const;

/**
 * New Coding Bot: a team of three roles (Planner, Developer, QA) that plans, writes and checks a software project in
 * a folder you choose. Each role can run on its own model. You describe the project in the bot's chat afterwards.
 */
export function NewCodingBotDialog() {
  const setOverlay = useUi((state) => state.setOverlay);
  const select = useUi((state) => state.select);
  const create = useCreateCodingBot();
  const [form, setForm] = useState<CodingForm>(DEFAULT_CODING_FORM);
  // The folder dialog only exists in the desktop app; in a plain browser the path is typed.
  const pickFolder = window.mrog?.pickFolder;
  const [picking, setPicking] = useState(false);
  const close = () => setOverlay(null);
  const problem = codingFormProblem(form);
  const change = (patch: Partial<CodingForm>) => {
    if (create.error) create.reset();
    setForm((current) => ({ ...current, ...patch }));
  };

  const browse = async () => {
    if (!pickFolder || picking) return;
    setPicking(true);
    try {
      const folder = await pickFolder();
      if (folder) change({ outputFolder: folder });
    } finally {
      setPicking(false);
    }
  };

  return (
    <Modal title="New Coding Bot" onClose={close} className="max-w-xl">
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem || create.isPending) return;
          create.mutate(codingInput(form), {
            onSuccess: ({ bot }) => {
              select(bot.threadId);
              close();
            },
          });
        }}
      >
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
          <p className="text-[13px] text-ink-2">
            A Planner, a Developer and a QA bot build a project for you in a folder on this computer. You
            describe it in the bot's chat, check the plan, and watch the board fill up.
          </p>

          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-[13px] font-medium">
              <CodeXml size={14} className="text-ink-3" /> Name
            </span>
            <input
              value={form.name}
              onChange={(event) => change({ name: event.target.value })}
              maxLength={60}
              className={cn(field, "h-8")}
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="coding-folder" className="text-[13px] font-medium">
              Output folder <span className="font-normal text-danger">required</span>
            </label>
            <div className="flex gap-2">
              <input
                id="coding-folder"
                value={form.outputFolder}
                onChange={(event) => change({ outputFolder: event.target.value })}
                placeholder="C:\Projects\my-app"
                spellCheck={false}
                autoComplete="off"
                className={cn(field, "h-8 min-w-0 flex-1 font-mono")}
              />
              {pickFolder && (
                <Button
                  type="button"
                  size="sm"
                  className="h-8"
                  onClick={() => void browse()}
                  disabled={picking}
                >
                  <FolderOpen size={14} /> Browse…
                </Button>
              )}
            </div>
            <span className="text-xs text-ink-3">
              Every file the team writes goes here. It is created if it doesn't exist. Running commands
              (tests, installs) still asks you first.
            </span>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">
              Models <span className="font-normal text-ink-3">· one for each role</span>
            </span>
            {ROLES.map((role) => (
              <div key={role.key} className="flex flex-col gap-1 rounded-xl border border-border p-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="w-20 shrink-0 text-[13px] font-medium">{role.name}</span>
                  <ModelSelect
                    value={form[role.key]}
                    onChange={(model) => change({ [role.key]: model })}
                    label={`${role.name}'s model`}
                    className="h-8 flex-1"
                  />
                </div>
                <span className="text-xs text-ink-3">{role.does}</span>
              </div>
            ))}
          </div>

          <div className="flex items-start gap-3 rounded-xl border border-border p-3">
            <Switch
              on={form.autoApprove}
              onChange={(autoApprove) => change({ autoApprove })}
              label="Auto-approve the plan"
            />
            <div className="min-w-0">
              <p className="text-[13px] font-medium">Auto-approve the plan</p>
              <p className="text-xs text-ink-3">
                Off: the Developer waits until you approve the plan. On: it starts as soon as the plan is
                ready.
              </p>
            </div>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">QA round limit</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_ROUNDS_LIMIT}
              value={form.maxRounds}
              onChange={(event) => change({ maxRounds: event.target.value })}
              className={cn(field, "h-8 w-24")}
            />
            <span className="text-xs text-ink-3">
              After this many rounds of fixes it stops and asks you. You can raise it later.
            </span>
          </label>
        </div>

        <div className="flex items-center gap-3 border-t border-border px-5 py-3">
          <span className="min-w-0 flex-1 text-xs text-ink-3" aria-live="polite">
            {create.error ? (
              <span className="text-danger">{create.error.message}</span>
            ) : (
              (problem ?? "Ready when you are.")
            )}
          </span>
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={Boolean(problem) || create.isPending}>
            {create.isPending ? <Loader2 size={14} className="animate-spin" /> : <CodeXml size={14} />}
            Create Coding Bot
          </Button>
        </div>
      </form>
    </Modal>
  );
}
