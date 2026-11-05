import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  appAccess,
  setAppAccess,
  setToolEnabled,
  TOOL_GROUPS,
  type AppAccess,
  type Bot,
  type ToolInfo,
} from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { botToolsKey, useBotTools, useUpdateBot } from "../../hooks/bots";

/**
 * Which tools this bot may use. Every tool is on unless switched off here; fewer tools means a shorter prompt, which
 * is what a small local model needs to pick the right one. A switch changes only the bot's list of tools turned off:
 * an allow list set through the API is kept as it is.
 */
export function ToolsBlock({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const { data: tools } = useBotTools(bot.id);
  const update = useUpdateBot();
  const client = useQueryClient();

  const save = (next: Bot["tools"]) =>
    update.mutate(
      { id: bot.id, patch: { tools: next } },
      { onSuccess: () => void client.invalidateQueries({ queryKey: botToolsKey(bot.id) }) },
    );

  const off = tools?.filter((tool) => !tool.enabled).length ?? 0;
  const restricted = bot.tools.allow !== null;
  const summary = restricted
    ? bot.tools.allow!.length === 0
      ? "No tools"
      : `Only some tools${off > 0 ? ` (${off} off)` : ""}`
    : off === 0
      ? "All tools on"
      : `${off} tool${off === 1 ? "" : "s"} off`;

  return (
    <section className="border-b border-border px-4 py-3.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 text-left"
      >
        <ChevronRight
          size={13}
          className={cn("shrink-0 text-ink-3 transition-transform", open && "rotate-90")}
        />
        <h3 className="flex-1 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">Tools</h3>
        <span className={cn("text-[12px]", off > 0 || restricted ? "text-warning" : "text-ink-3")}>
          {summary}
        </span>
      </button>

      {open && (
        <div className="mt-2">
          <p className="mb-2 text-[11.5px] text-ink-3">
            Switch off what {bot.name} doesn't need. A shorter list helps small models choose well.
          </p>
          {restricted && (
            <p className="mb-2 rounded-md bg-selected px-2 py-1.5 text-[12px] text-ink-2">
              {bot.tools.allow!.length === 0
                ? `${bot.name} has no tools: its list allows none.`
                : `${bot.name} may use only the tools its list allows (set through the API). Tools outside it can't be switched on here.`}
            </p>
          )}
          {!tools ? (
            <p className="text-[13px] text-ink-3">Loading…</p>
          ) : (
            TOOL_GROUPS.map((group) => {
              const rows = tools.filter((tool) => tool.group === group.id);
              if (rows.length === 0) return null;
              const row = (tool: ToolInfo) => (
                <ToolRow
                  key={tool.name}
                  tool={tool}
                  disabled={update.isPending}
                  onChange={(on) => save(setToolEnabled(bot.tools, tool.name, on))}
                />
              );
              // A connected app's tools sit under the app, with how much the bot may do there.
              const apps = [
                ...new Map(
                  rows.flatMap((tool) => (tool.app ? [[tool.app.id, tool.app.name] as const] : [])),
                ).entries(),
              ];
              const loose = rows.filter((tool) => !tool.app);
              return (
                <fieldset key={group.id} className="mb-2.5">
                  <legend className="mb-1 text-[11.5px] font-medium text-ink-3">{group.label}</legend>
                  {apps.map(([id, name]) => (
                    <div key={id} className="mb-1.5">
                      <label className="flex items-center gap-2 px-1.5 py-1 text-[13px]">
                        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                        <select
                          aria-label={`${bot.name}'s access to ${name}`}
                          value={appAccess(bot.tools, id)}
                          disabled={update.isPending}
                          onChange={(event) =>
                            save(setAppAccess(bot.tools, id, event.target.value as AppAccess))
                          }
                          className="rounded-md border border-border bg-bg px-1.5 py-0.5 text-[12px]"
                        >
                          <option value="full">Can make changes</option>
                          <option value="read">Read only</option>
                          <option value="off">No access</option>
                        </select>
                      </label>
                      <ul className="flex flex-col gap-0.5 pl-2">
                        {rows.filter((tool) => tool.app?.id === id).map(row)}
                      </ul>
                    </div>
                  ))}
                  {loose.length > 0 && <ul className="flex flex-col gap-0.5">{loose.map(row)}</ul>}
                </fieldset>
              );
            })
          )}
          {bot.tools.exclude.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="-ml-2"
              disabled={update.isPending}
              onClick={() => save({ ...bot.tools, exclude: [] })}
            >
              Switch everything back on
            </Button>
          )}
          {update.isError && <p className="mt-1 text-xs text-danger">{update.error.message}</p>}
        </div>
      )}
    </section>
  );
}

function ToolRow({
  tool,
  disabled,
  onChange,
}: {
  tool: ToolInfo;
  disabled: boolean;
  onChange(on: boolean): void;
}) {
  const reason = !tool.editable
    ? `Off: ${tool.heldBy ?? "held off by a pattern or an allow list set through the API"}`
    : !tool.available
      ? "Not available right now (a stopped computer, a disconnected app), but still in this bot's list"
      : tool.description;
  return (
    <li>
      <label
        title={reason}
        className={cn(
          "flex items-start gap-2 rounded-md px-1.5 py-1 text-[13px]",
          tool.editable ? "cursor-pointer hover:bg-hover" : "opacity-60",
        )}
      >
        <input
          type="checkbox"
          className="mt-0.5"
          checked={tool.enabled}
          disabled={disabled || !tool.editable}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="min-w-0 flex-1">
          <span className="font-mono text-[12.5px] break-all">{tool.name}</span>
          {!tool.available && <span className="ml-1.5 text-[11px] text-ink-3">not available now</span>}
          {tool.app && tool.app.kind !== "write" && (
            <span
              className={cn(
                "ml-1.5 text-[11px]",
                tool.app.kind === "destructive" ? "text-danger" : "text-ink-3",
              )}
            >
              {tool.app.kind === "read" ? "only reads" : "can't be undone, always asks"}
            </span>
          )}
          {tool.heldBy && <span className="block text-[11px] text-ink-3">{tool.heldBy}</span>}
        </span>
      </label>
    </li>
  );
}
