import { ClipboardCopy, Cpu, Download, FileUp } from "lucide-react";
import { useState, type MouseEvent } from "react";

import { CODING_ROLES, type Bot, type CodingProject, type CodingRole } from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { useUpdateCodingSettings } from "../../hooks/coding";
import { canEditModels, canImportPlan } from "../../lib/coding";
import {
  exportName,
  MIME,
  planningPrompt,
  planToFile,
  snapshotOf,
  toMarkdown,
  toMermaid,
  toSvg,
  type ExportKind,
} from "../../lib/codingExport";
import { roleLabel } from "../../lib/coding";
import { downloadText } from "../../lib/download";
import { ContextMenu, type MenuEntry } from "../ContextMenu";
import { ModelSelect } from "../ModelSelect";
import { ImportDialog } from "./ImportDialog";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** What each export writes. */
function render(kind: ExportKind, project: CodingProject, botName: string): string {
  switch (kind) {
    case "plan":
      return json(planToFile(project));
    case "markdown":
      return toMarkdown(project, botName);
    case "mermaid":
      return toMermaid(project);
    case "svg":
      return toSvg(project);
    case "snapshot":
      return json(snapshotOf(project, new Date()));
  }
}

/** Export, import, the planning prompt and the role models: the plan's tools, in a row under the header. */
export function PlanTools({ bot, project }: { bot: Bot; project: CodingProject }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const [models, setModels] = useState(false);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const hasPlan = project.nodes.length > 0;

  const save = (kind: ExportKind) => () =>
    downloadText(exportName(bot.name, kind), render(kind, project, bot.name), MIME[kind]);
  const entries: MenuEntry[] = [
    { label: "Plan (JSON, can be imported)", onSelect: save("plan") },
    { label: "Markdown", onSelect: save("markdown") },
    { label: "Mermaid diagram", onSelect: save("mermaid") },
    { label: "Diagram (SVG picture)", onSelect: save("svg") },
    "separator",
    { label: "Project snapshot (JSON)", onSelect: save("snapshot") },
  ];

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(planningPrompt(project.brief));
      setCopied("yes");
    } catch {
      setCopied("no");
    }
    setTimeout(() => setCopied(null), 2500);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={!hasPlan}
          title={hasPlan ? "Download the plan" : "There is no plan to export yet"}
          aria-haspopup="menu"
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
        >
          <Download size={13} /> Export
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canImportPlan(project.status)}
          title={canImportPlan(project.status) ? "Import a plan" : "Stop the team to import a plan"}
          onClick={() => setImporting(true)}
        >
          <FileUp size={13} /> Import
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void copyPrompt()}
          title="Text to give a larger model so it writes a plan this app can import"
        >
          <ClipboardCopy size={13} /> Copy planning prompt
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={models}
          onClick={() => setModels((open) => !open)}
          className={cn(models && "bg-selected")}
        >
          <Cpu size={13} /> Models
        </Button>
        <span role="status" className="text-xs text-ink-3">
          {copied === "yes"
            ? "Prompt copied."
            : copied === "no"
              ? "Couldn't copy. Select the text yourself."
              : ""}
        </span>
      </div>

      {models && <Models bot={bot} project={project} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={entries} onClose={() => setMenu(null)} />}
      {importing && <ImportDialog botId={bot.id} onClose={() => setImporting(false)} />}
    </div>
  );
}

/** The model for each role, changeable whenever the team isn't in the middle of a step. */
function Models({ bot, project }: { bot: Bot; project: CodingProject }) {
  const settings = useUpdateCodingSettings(bot.id);
  const editable = canEditModels(project.status);
  const pick = (role: CodingRole, model: string | null) => settings.mutate({ roles: { [role]: { model } } });
  return (
    <fieldset
      disabled={!editable || settings.isPending}
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-bg p-2.5"
    >
      <legend className="px-1 text-[12px] font-medium text-ink-2">Models for each role</legend>
      {CODING_ROLES.map((role) => (
        <div key={role} className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[12.5px]">{roleLabel(role)}</span>
          <ModelSelect
            value={project.roles[role].model}
            onChange={(model) => pick(role, model)}
            label={`${roleLabel(role)}'s model`}
            className="h-8 flex-1"
          />
        </div>
      ))}
      <p className="text-xs text-ink-3">
        {editable
          ? "The next step a role takes uses its new model."
          : "Stop the team to change models: a step in progress keeps the model it started with."}
      </p>
      {settings.error && (
        <p role="alert" className="text-xs text-danger">
          {settings.error.message}
        </p>
      )}
    </fieldset>
  );
}
