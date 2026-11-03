import { Flame, Play, Power } from "lucide-react";
import { useState } from "react";

import { Button } from "@mrog/ui-kit";

import {
  formatBytes,
  useModels,
  useRuntime,
  useStartOllama,
  useUnloadModel,
  useUpdateRuntime,
  useWarmup,
} from "../../hooks/runtime";
import { LocalModelList, PullModel } from "./ModelPicker";
import { Field, Section } from "./parts";

const KEEP_ALIVE = [
  { value: "5m", label: "5 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "2h", label: "2 hours" },
  { value: "-1", label: "While the app is open" },
];
const CONTEXT_SIZES = [8192, 16384, 32768, 65536, 131072, 262144];

export function LocalModelSettings() {
  const { data: runtime } = useRuntime();
  const { data: catalog } = useModels();
  const update = useUpdateRuntime();
  const unload = useUnloadModel();
  const warmup = useWarmup();
  const start = useStartOllama();
  if (!runtime) return null;
  const { settings, loaded, queue } = runtime;
  const local = (catalog?.models ?? []).filter((model) => model.providerId === "ollama");

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Shared model"
        description="Every bot uses this model unless it has its own. It stays loaded, so bots share one copy in memory."
      >
        {runtime.ollama.reachable ? (
          <LocalModelList
            models={local}
            selected={settings.sharedModel}
            onSelect={(ref) => update.mutate({ sharedModel: ref })}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <p className="text-[13px] text-danger">Ollama isn't reachable at {settings.ollamaUrl}.</p>
              <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
                <Play size={13} /> {start.isPending ? "Starting…" : "Start Ollama"}
              </Button>
            </div>
            {start.error && <p className="text-xs text-danger">{start.error.message}</p>}
          </div>
        )}
      </Section>

      <Section title="Loaded now" description={`${queue.running} running · ${queue.waiting} waiting`}>
        {loaded.length === 0 ? (
          <div className="flex items-center gap-3 text-[13px] text-ink-3">
            Nothing is loaded.
            {settings.sharedModel && (
              <Button size="sm" onClick={() => warmup.mutate()} disabled={warmup.isPending}>
                <Flame size={13} /> {warmup.isPending ? "Loading…" : "Load shared model"}
              </Button>
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {loaded.map((model) => (
              <li
                key={model.name}
                className="flex items-center gap-3 rounded-lg bg-hover px-3 py-2 text-[13px]"
              >
                <span className="size-1.5 rounded-full bg-success" />
                <span className="min-w-0 flex-1 truncate font-medium">{model.name}</span>
                <span className="text-xs text-ink-3">
                  {formatBytes(model.vramBytes)} VRAM
                  {model.sizeBytes > model.vramBytes
                    ? ` · ${formatBytes(model.sizeBytes - model.vramBytes)} RAM`
                    : ""}
                  {model.contextLength ? ` · ${model.contextLength.toLocaleString()} ctx` : ""}
                </span>
                <Button size="sm" variant="ghost" onClick={() => unload.mutate(model.name)}>
                  <Power size={13} /> Unload
                </Button>
              </li>
            ))}
          </ul>
        )}
        {loaded.some((model) => model.sizeBytes > model.vramBytes * 1.02) && (
          <p className="text-[12.5px] text-ink-2">
            Part of the model doesn't fit on the graphics card and runs on the processor, which is much
            slower. A smaller context size keeps it all on the GPU.
          </p>
        )}
      </Section>

      <Section title="Performance">
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Context size"
            hint="How much a bot can keep in mind during a task. Research and browsing need 32k or more; 64k fits a 12 GB GPU. Same for every bot so the model never reloads."
          >
            <select
              value={settings.numCtx}
              onChange={(event) => update.mutate({ numCtx: Number(event.target.value) })}
              className="select"
            >
              {CONTEXT_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size.toLocaleString()} tokens
                </option>
              ))}
            </select>
          </Field>
          <Field label="Keep loaded" hint="How long the model stays in memory when idle.">
            <select
              value={settings.keepAlive}
              onChange={(event) => update.mutate({ keepAlive: event.target.value })}
              className="select"
            >
              {KEEP_ALIVE.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Bots at once" hint="Match Ollama's OLLAMA_NUM_PARALLEL; the rest wait in line.">
            <select
              value={settings.parallel}
              onChange={(event) => update.mutate({ parallel: Number(event.target.value) })}
              className="select"
            >
              {[1, 2, 3, 4, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Thinking" hint="Let thinking models reason before answering (slower).">
            <label className="flex h-8 items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={settings.think}
                onChange={(event) => update.mutate({ think: event.target.checked })}
              />
              Allow thinking
            </label>
          </Field>
        </div>
      </Section>

      <Section title="Download a model">
        <PullModel installed={new Set(local.map((model) => model.id))} />
      </Section>

      <Section title="Ollama">
        <OllamaAddress key={settings.ollamaUrl} current={settings.ollamaUrl} />
        <label className="mt-3 flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={settings.startOllama}
            onChange={(event) => update.mutate({ startOllama: event.target.checked })}
          />
          Start Ollama On Start
        </label>
        <p className="mt-1 text-xs text-ink-3">
          Starts Ollama when FreeBird opens, only if it runs on this computer and isn't already running. It
          keeps running after you close the app, as if you had opened it yourself.
        </p>
      </Section>
    </div>
  );
}

/** Keyed by the saved address, so it resets when the address changes elsewhere. */
function OllamaAddress({ current }: { current: string }) {
  const update = useUpdateRuntime();
  const [url, setUrl] = useState(current);
  return (
    <>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          update.mutate({ ollamaUrl: url });
        }}
      >
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          aria-label="Ollama address"
          className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 font-mono text-xs outline-none focus:border-accent"
        />
        <Button size="sm" type="submit" disabled={url === current}>
          Save
        </Button>
      </form>
      {update.error && <p className="mt-1 text-xs text-danger">{update.error.message}</p>}
    </>
  );
}
