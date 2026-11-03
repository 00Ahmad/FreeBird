import { ExternalLink, Monitor, Power, RotateCcw, X } from "lucide-react";

import type { Bot } from "@mrog/shared";
import { Button, IconButton } from "@mrog/ui-kit";

import { useBotComputer, useComputerAction, useComputerStatus } from "../../hooks/phase5";
import { useUi } from "../../state";

/** The bot's own computer in the right panel: live desktop, take over by clicking into it (UI-SPEC §8). */
export function ComputerPanel({ bot }: { bot: Bot }) {
  const { data: status } = useComputerStatus();
  const { data: computer } = useBotComputer(bot.id);
  const action = useComputerAction(bot.id);
  const setPanel = useUi((state) => state.setPanel);
  const busy = action.isPending || computer?.state === "starting";

  return (
    <aside
      className="flex h-full w-[46%] min-w-80 shrink-0 flex-col border-l border-border bg-surface"
      aria-label="Computer"
    >
      <div className="flex items-center gap-1 border-b border-border px-4 py-2.5">
        <Monitor size={15} className="text-ink-2" />
        <h2 className="flex-1 text-[14px] font-semibold">{bot.name}'s computer</h2>
        {computer?.state === "running" && computer.url && (
          <>
            <IconButton label="Open desktop" onClick={() => window.open(computer.url!, "_blank")}>
              <ExternalLink size={14} />
            </IconButton>
            <IconButton label="Stop" onClick={() => action.mutate("stop")}>
              <Power size={14} />
            </IconButton>
            <IconButton
              label="Reset Bot's Computer"
              onClick={() =>
                window.confirm("Rebuild the computer? Files in its home folder are kept.") &&
                action.mutate("reset")
              }
            >
              <RotateCcw size={14} />
            </IconButton>
          </>
        )}
        <IconButton label="Close computer" onClick={() => setPanel("computer")}>
          <X size={15} />
        </IconButton>
      </div>

      {!status ? (
        <p className="flex flex-1 items-center justify-center text-[13px] text-ink-3">Checking Docker…</p>
      ) : !status.docker.available ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-[13px]">
          <p className="font-medium">Docker isn't running</p>
          <p className="max-w-xs text-ink-3">
            Each bot's computer is a Docker container with a desktop. Start Docker Desktop, then try again.
          </p>
          <p className="max-w-xs font-mono text-[11px] text-ink-3">{status.docker.error}</p>
        </div>
      ) : computer?.state === "running" && computer.url ? (
        <>
          {/* The desktop is a different origin (another port), so allow-same-origin only grants it its own
              storage and websocket, which its web client needs; it can't reach this page. */}
          <iframe
            title={`${bot.name}'s desktop`}
            src={computer.url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads"
            allow="clipboard-read; clipboard-write; fullscreen"
            className="min-h-0 flex-1 bg-black"
          />
          <p className="border-t border-border px-4 py-2 text-[11.5px] text-ink-3">
            Click into the desktop to take over (sign-ins, CAPTCHAs). Tell the bot when you're done.
          </p>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-[13px]">
          <Monitor size={28} className="text-ink-3" />
          <p className="max-w-xs text-ink-2">
            A private Linux desktop for {bot.name}: a browser, files and a terminal, kept apart from this
            computer.
          </p>
          <Button variant="primary" disabled={busy || !status} onClick={() => action.mutate("start")}>
            {busy
              ? "Starting… (the first start downloads the desktop)"
              : computer?.state === "stopped"
                ? "Start computer"
                : "Set up computer"}
          </Button>
          <p className="font-mono text-[11px] text-ink-3">{status?.image}</p>
          {(computer?.error || action.data?.computer.error) && (
            <p className="max-w-xs text-xs text-danger">{computer?.error ?? action.data?.computer.error}</p>
          )}
        </div>
      )}
    </aside>
  );
}
