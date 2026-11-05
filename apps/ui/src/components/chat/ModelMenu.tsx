import { Check, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { parseModelRef, type Bot } from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { useUpdateBot } from "../../hooks/bots";
import { useProviders } from "../../hooks/providers";
import { useModels, useRuntime } from "../../hooks/runtime";
import { retryReply } from "../../hooks/threads";
import { useUi } from "../../state";
import { ModelBadge } from "../ModelBadge";
import { CapabilityBadges } from "../settings/ModelPicker";

/** The chat header's model switch: provider rail on the left, its models on the right. */
export function ModelMenu({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const request = useUi((state) => (state.modelSwitch?.botId === bot.id ? state.modelSwitch : null));
  const clearRequest = useUi((state) => state.clearModelSwitch);

  // A reply that is stuck or failed asked for this menu: it is open for as long as that request stands.
  const shown = open || request !== null;

  /** Closing without picking drops the request, so a later pick can't try an old reply again. */
  const close = useCallback(() => {
    setOpen(false);
    clearRequest();
  }, [clearRequest]);

  useEffect(() => {
    if (!shown) return;
    const outside = (event: PointerEvent) => !ref.current?.contains(event.target as Node) && close();
    const key = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key);
    };
  }, [shown, close]);

  return (
    <div ref={ref} className="relative">
      <ModelBadge botModel={bot.model} onClick={() => (shown ? close() : setOpen(true))} />
      {shown && <ModelPanel bot={bot} request={request} onClose={close} />}
    </div>
  );
}

function ModelPanel({
  bot,
  request,
  onClose,
}: {
  bot: Bot;
  request: NonNullable<ReturnType<typeof useUi.getState>["modelSwitch"]> | null;
  onClose(): void;
}) {
  const { data: catalog } = useModels();
  const { data: providers } = useProviders();
  const { data: runtime } = useRuntime();
  const update = useUpdateBot();
  const openSettings = useUi((state) => state.openSettings);
  const current = bot.model ? parseModelRef(bot.model).providerId : "shared";
  const [rail, setRail] = useState(current);

  const rails = [
    { id: "shared", label: "Shared model", error: undefined as string | undefined },
    { id: "ollama", label: "Ollama", error: catalog?.errors.find((e) => e.providerId === "ollama")?.message },
    ...(providers?.providers ?? [])
      .filter((provider) => provider.enabled)
      .map((provider) => ({
        id: provider.id,
        label: provider.label,
        error: catalog?.errors.find((e) => e.providerId === provider.id)?.message,
      })),
  ];
  const models = (catalog?.models ?? []).filter(
    (model) => model.providerId === rail && !model.capabilities.every((cap) => cap === "embedding"),
  );
  const pick = (ref: string | null) => {
    // The menu closes right away, which unmounts this panel; a callback passed to `mutate` would then never run. The
    // promise lives on without it.
    const switched = update.mutateAsync({ id: bot.id, patch: { model: ref } });
    if (request?.retryMessageId) {
      const { threadId, retryMessageId } = request;
      // The model is chosen when a reply starts, so the one that was stuck or failed has to start again to use it.
      void switched
        .then(() => retryReply({ threadId, botId: bot.id, messageId: retryMessageId }))
        .catch(() => {});
    } else void switched.catch(() => {});
    onClose();
  };

  return (
    <div
      className="absolute top-full right-0 z-30 mt-1.5 flex h-80 w-[520px] overflow-hidden rounded-xl border border-border bg-surface shadow-pop"
      role="dialog"
      aria-label="Choose model"
    >
      <nav className="flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-sidebar p-1.5">
        {rails.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setRail(item.id)}
            title={item.error}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-left text-[13px]",
              rail === item.id ? "bg-selected font-medium" : "hover:bg-hover",
              item.error && "text-ink-3",
            )}
          >
            {item.label}
            {item.error && <span className="block truncate text-[11px] text-danger">unavailable</span>}
          </button>
        ))}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => openSettings("providers")}>
          <Settings2 size={13} /> Providers
        </Button>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto p-1.5">
        {rail === "shared" ? (
          <button
            type="button"
            onClick={() => pick(null)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-hover"
          >
            <span className="min-w-0 flex-1">
              <span className="block font-medium">Use the shared model</span>
              <span className="block truncate text-xs text-ink-3">
                {runtime?.settings.sharedModel ?? "none set"}
              </span>
            </span>
            {!bot.model && <Check size={14} className="text-accent" />}
          </button>
        ) : models.length === 0 ? (
          <p className="px-2.5 py-2 text-[13px] text-ink-3">
            {rails.find((item) => item.id === rail)?.error ?? "No models."}
          </p>
        ) : (
          models.map((model) => (
            <button
              key={model.ref}
              type="button"
              onClick={() => pick(model.ref)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-hover"
            >
              <span className="min-w-0 flex-1 truncate">{model.label}</span>
              {model.loaded && <span className="size-1.5 rounded-full bg-success" aria-label="Loaded now" />}
              {!model.capabilities.includes("tools") && (
                <span
                  className="text-[11px] text-ink-3"
                  title="Uses tools through a text format; less reliable"
                >
                  no tools
                </span>
              )}
              <CapabilityBadges model={model} />
              {bot.model === model.ref && <Check size={14} className="text-accent" />}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
