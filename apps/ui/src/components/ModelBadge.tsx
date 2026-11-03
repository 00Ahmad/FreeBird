import { Cpu } from "lucide-react";

import { parseModelRef } from "@mrog/shared";
import { cn } from "@mrog/ui-kit";

import { effectiveModel, useRuntime } from "../hooks/runtime";
import { useUi } from "../state";

/** The model a bot runs on, with a green dot when it's loaded in memory right now. */
export function ModelBadge({ botModel, onClick }: { botModel: string | null; onClick?(): void }) {
  const { data: runtime } = useRuntime();
  const openSettings = useUi((state) => state.openSettings);
  const ref = effectiveModel(botModel, runtime);
  const parsed = ref ? parseModelRef(ref) : null;
  const loaded =
    parsed?.providerId === "ollama" && runtime?.loaded.some((model) => model.name === parsed.model);

  return (
    <button
      type="button"
      onClick={onClick ?? (() => openSettings("model"))}
      title={
        ref
          ? `${ref}${botModel ? "" : " (shared model)"}${loaded ? " · loaded now" : ""}`
          : "No model selected"
      }
      className="flex max-w-56 items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs text-ink-2 hover:bg-hover"
    >
      <Cpu size={13} className="shrink-0" />
      <span className="truncate">{parsed ? parsed.model : "No model"}</span>
      {parsed && (
        <span
          className={cn("size-1.5 shrink-0 rounded-full", loaded ? "bg-success" : "bg-ink-3/40")}
          aria-label={loaded ? "Loaded now" : "Not loaded"}
        />
      )}
    </button>
  );
}
