import { CheckCircle2, ExternalLink, Play, RefreshCw, XCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@mrog/ui-kit";

import { useModels, useRuntime, useStartOllama, useUpdateRuntime } from "../../hooks/runtime";
import { LocalModelList, PullModel } from "../settings/ModelPicker";

/** First run: find Ollama and pick the one model every bot will share. */
export function SetupPanel() {
  const { data: runtime, refetch: refetchRuntime, isFetching } = useRuntime();
  const { data: catalog, refetch: refetchModels } = useModels();
  const update = useUpdateRuntime();
  const start = useStartOllama();
  const [url, setUrl] = useState<string | null>(null);

  const reachable = runtime?.ollama.reachable ?? false;
  const local = (catalog?.models ?? []).filter((model) => model.providerId === "ollama");
  const retry = () => {
    void refetchRuntime();
    void refetchModels();
  };

  return (
    <main className="flex h-full justify-center overflow-y-auto bg-bg px-6 py-10">
      <div className="flex w-full max-w-xl flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Set up your local model</h1>
          <p className="mt-1 text-[13px] text-ink-2">
            Bots run on a model on this computer through Ollama. One model stays loaded and every bot shares
            it, so it stays fast and light. You can add cloud providers later in Settings.
          </p>
        </div>

        <section className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2 text-[14px] font-medium">
            {reachable ? (
              <CheckCircle2 size={17} className="text-success" />
            ) : (
              <XCircle size={17} className="text-danger" />
            )}
            {reachable ? `Ollama ${runtime?.ollama.version} is running` : "Ollama isn't reachable"}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={retry} disabled={isFetching}>
              <RefreshCw size={13} /> Check again
            </Button>
          </div>
          {!reachable && (
            <div className="flex flex-col gap-2 text-[13px] text-ink-2">
              <p>
                Install Ollama, start it, then check again. If it runs on another computer or port, enter its
                address.
              </p>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  onClick={() => start.mutate(undefined, { onSuccess: retry })}
                  disabled={start.isPending}
                >
                  <Play size={13} /> {start.isPending ? "Starting…" : "Start Ollama"}
                </Button>
                {start.error && <span className="text-xs text-danger">{start.error.message}</span>}
              </div>
              <a
                href="https://ollama.com/download"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent hover:underline"
              >
                Download Ollama <ExternalLink size={12} />
              </a>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (url) update.mutate({ ollamaUrl: url }, { onSuccess: retry });
                }}
              >
                <input
                  value={url ?? runtime?.ollama.url ?? ""}
                  onChange={(event) => setUrl(event.target.value)}
                  aria-label="Ollama address"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 font-mono text-xs outline-none focus:border-accent"
                />
                <Button size="sm" type="submit" disabled={!url}>
                  Use address
                </Button>
              </form>
              {update.error && <p className="text-xs text-danger">{update.error.message}</p>}
            </div>
          )}
        </section>

        {reachable && (
          <section className="flex flex-col gap-3">
            <h2 className="text-[14px] font-semibold">Choose the shared model</h2>
            <LocalModelList
              models={local}
              selected={runtime?.settings.sharedModel ?? null}
              onSelect={(ref) => update.mutate({ sharedModel: ref })}
            />
            <h2 className="mt-2 text-[14px] font-semibold">Or download one</h2>
            <PullModel installed={new Set(local.map((model) => model.id))} />
          </section>
        )}
      </div>
    </main>
  );
}
