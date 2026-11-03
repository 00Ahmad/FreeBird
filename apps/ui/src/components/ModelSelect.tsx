import { parseModelRef } from "@mrog/shared";
import { cn } from "@mrog/ui-kit";

import { useProviders } from "../hooks/providers";
import { useModels, useRuntime } from "../hooks/runtime";

/**
 * Pick the model one bot runs on: the shared model, or any model from Ollama or a cloud provider (Settings →
 * Providers). `null` means the shared model.
 */
export function ModelSelect({
  value,
  onChange,
  label,
  className,
}: {
  value: string | null;
  onChange(ref: string | null): void;
  label: string;
  className?: string;
}) {
  const { data: catalog } = useModels();
  const { data: providers } = useProviders();
  const { data: runtime } = useRuntime();
  const shared = runtime?.settings.sharedModel;
  const names = new Map((providers?.providers ?? []).map((provider) => [provider.id, provider.label]));
  // Chat models only: embedding models can't answer.
  const models = (catalog?.models ?? []).filter(
    (model) => !model.capabilities.includes("embedding") || model.capabilities.includes("completion"),
  );
  const groups = [...new Set(models.map((model) => model.providerId))].map((providerId) => ({
    providerId,
    label: providerId === "ollama" ? "Ollama (this computer)" : (names.get(providerId) ?? providerId),
    models: models.filter((model) => model.providerId === providerId),
  }));

  return (
    <select
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || null)}
      aria-label={label}
      title={label}
      className={cn("select min-w-0", className)}
    >
      <option value="">Shared model{shared ? ` (${parseModelRef(shared).model})` : ""}</option>
      {groups.map((group) => (
        <optgroup key={group.providerId} label={group.label}>
          {group.models.map((model) => (
            <option key={model.ref} value={model.ref}>
              {model.label}
            </option>
          ))}
        </optgroup>
      ))}
      {/* A model picked earlier that's no longer listed stays visible instead of silently changing. */}
      {value && !models.some((model) => model.ref === value) && (
        <option value={value}>{value} (not available)</option>
      )}
    </select>
  );
}
