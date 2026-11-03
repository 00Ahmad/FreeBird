import { Check, Download, Eye, Brain, Wrench } from "lucide-react";
import { useState } from "react";

import { RECOMMENDED_LOCAL_MODELS, type ModelInfo } from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { formatBytes, useCancelPull, usePullModel } from "../../hooks/runtime";
import { useUi } from "../../state";

export function CapabilityBadges({ model }: { model: ModelInfo }) {
  const caps = new Set(model.capabilities);
  return (
    <span className="flex items-center gap-1 text-ink-3">
      {caps.has("tools") && <Wrench size={12} aria-label="Tools" />}
      {caps.has("vision") && <Eye size={12} aria-label="Vision" />}
      {caps.has("thinking") && <Brain size={12} aria-label="Thinking" />}
    </span>
  );
}

/** Installed local chat models; tool-capable ones first, since bots need tools for real work. */
export function LocalModelList({
  models,
  selected,
  onSelect,
}: {
  models: ModelInfo[];
  selected: string | null;
  onSelect(ref: string): void;
}) {
  const chat = models
    .filter((model) => !model.capabilities.includes("embedding") || model.capabilities.includes("completion"))
    .filter((model) => !model.capabilities.every((cap) => cap === "embedding"))
    .toSorted(
      (a, b) =>
        Number(b.capabilities.includes("tools")) - Number(a.capabilities.includes("tools")) ||
        a.label.localeCompare(b.label),
    );
  if (chat.length === 0) return <p className="text-[13px] text-ink-3">No models installed yet.</p>;
  return (
    <ul
      className="max-h-72 overflow-y-auto rounded-xl border border-border"
      role="listbox"
      aria-label="Installed models"
    >
      {chat.map((model) => (
        <li key={model.ref}>
          <button
            type="button"
            role="option"
            aria-selected={selected === model.ref}
            onClick={() => onSelect(model.ref)}
            className={cn(
              "flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left text-[13px] last:border-b-0 hover:bg-hover",
              selected === model.ref && "bg-selected",
            )}
          >
            <span className="min-w-0 flex-1 truncate font-medium">{model.label}</span>
            {!model.capabilities.includes("tools") && (
              <span className="text-[11px] text-ink-3">no tools</span>
            )}
            <CapabilityBadges model={model} />
            {model.sizeBytes ? (
              <span className="w-16 text-right text-xs text-ink-3">{formatBytes(model.sizeBytes)}</span>
            ) : null}
            {model.loaded && <span className="size-1.5 rounded-full bg-success" aria-label="Loaded now" />}
            <Check size={14} className={cn("text-accent", selected !== model.ref && "invisible")} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Download a model by name, with live progress from runtime.pull events. */
export function PullModel({ installed }: { installed: Set<string> }) {
  const [name, setName] = useState("");
  const pull = usePullModel();
  const pulls = useUi((state) => state.pulls);
  const dropPull = useUi((state) => state.dropPull);
  const cancel = useCancelPull();
  const active = Object.entries(pulls).filter(([, state]) => !state.done || state.error);

  const start = (model: string) => {
    if (!model.trim()) return;
    pull.mutate(model.trim());
    setName("");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {RECOMMENDED_LOCAL_MODELS.filter((model) => !installed.has(model.id)).map((model) => (
          <Button key={model.id} size="sm" onClick={() => start(model.id)} title={model.note}>
            <Download size={13} /> {model.id}
          </Button>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          start(name);
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Any Ollama model, e.g. qwen3:8b"
          aria-label="Model to download"
          className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 text-[13px] outline-none focus:border-accent"
        />
        <Button size="sm" variant="primary" type="submit" disabled={!name.trim()}>
          Download
        </Button>
      </form>
      {pull.error && <p className="text-xs text-danger">{pull.error.message}</p>}
      {active.map(([model, state]) => (
        <div key={model} className="text-xs">
          <div className="flex items-center justify-between gap-2 text-ink-2">
            <span className="flex-1">{model}</span>
            <span>{state.error ? <span className="text-danger">{state.error}</span> : state.status}</span>
            <button
              type="button"
              className="text-ink-3 hover:text-ink"
              onClick={() => (state.error ? dropPull(model) : cancel.mutate(model))}
            >
              {state.error ? "Dismiss" : "Cancel"}
            </button>
          </div>
          {!state.error && (
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
              <div
                className="h-full bg-accent transition-[width]"
                style={{
                  width: state.total ? `${Math.round(((state.completed ?? 0) / state.total) * 100)}%` : "5%",
                }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
