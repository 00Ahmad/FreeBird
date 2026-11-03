import { CheckCircle2, ExternalLink, KeyRound, Plus, Trash2, XCircle, Zap } from "lucide-react";
import { useState } from "react";

import type { ProviderPreset, ProviderView } from "@mrog/shared";
import { Button, cn, IconButton } from "@mrog/ui-kit";

import {
  useAddProvider,
  useProviders,
  useRemoveProvider,
  useTestProvider,
  useUpdateProvider,
} from "../../hooks/providers";
import { useModels } from "../../hooks/runtime";
import { Field, Section, TextInput } from "./parts";

const GROUPS: { id: ProviderPreset["group"]; label: string }[] = [
  { id: "cloud", label: "Cloud" },
  { id: "local", label: "On your network" },
  { id: "custom", label: "Custom" },
];

export function ProvidersSettings() {
  const { data } = useProviders();
  const [adding, setAdding] = useState(false);
  if (!data) return null;

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Providers"
        description="Ollama on this computer is built in. Add cloud APIs or other local servers to give bots more models. Keys are kept in your system keychain."
      >
        <ul className="flex flex-col gap-2">
          <li className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5 text-[13px]">
            <span className="font-medium">Ollama</span>
            <span className="text-ink-3">this computer · built in</span>
          </li>
          {data.providers.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
        </ul>
        {adding ? (
          <AddProvider presets={data.presets} onDone={() => setAdding(false)} />
        ) : (
          <div>
            <Button onClick={() => setAdding(true)}>
              <Plus size={14} /> Add provider
            </Button>
          </div>
        )}
      </Section>
    </div>
  );
}

function ProviderRow({ provider }: { provider: ProviderView }) {
  const { data: catalog } = useModels();
  const test = useTestProvider();
  const update = useUpdateProvider();
  const remove = useRemoveProvider();
  const [key, setKey] = useState<string | null>(null);
  const models = catalog?.models.filter((model) => model.providerId === provider.id).length ?? 0;
  const error = catalog?.errors.find((candidate) => candidate.providerId === provider.id);

  return (
    <li
      className={cn(
        "rounded-xl border border-border px-3 py-2.5 text-[13px]",
        !provider.enabled && "opacity-60",
      )}
    >
      <div className="flex items-center gap-3">
        <span className="font-medium">{provider.label}</span>
        <span className="font-mono text-[11.5px] text-ink-3">{provider.id}</span>
        <span className="text-ink-3">{provider.local ? "local" : "cloud"}</span>
        <span className="flex-1" />
        {provider.enabled && !error && <span className="text-xs text-ink-3">{models} models</span>}
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          <input
            type="checkbox"
            checked={provider.enabled}
            onChange={(event) => update.mutate({ id: provider.id, patch: { enabled: event.target.checked } })}
          />
          On
        </label>
        <Button size="sm" variant="ghost" onClick={() => test.mutate(provider.id)} disabled={test.isPending}>
          <Zap size={13} /> Test
        </Button>
        <IconButton label="Replace key" onClick={() => setKey(key === null ? "" : null)}>
          <KeyRound size={14} />
        </IconButton>
        <IconButton
          label={`Remove ${provider.label}`}
          onClick={() =>
            window.confirm(`Remove ${provider.label} and its key?`) && remove.mutate(provider.id)
          }
        >
          <Trash2 size={14} />
        </IconButton>
      </div>
      {error && provider.enabled && <p className="mt-1.5 text-xs text-danger">{error.message}</p>}
      {test.data && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-success">
          <CheckCircle2 size={12} /> Connected · {test.data.models} models
        </p>
      )}
      {test.error && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-danger">
          <XCircle size={12} /> {test.error.message}
        </p>
      )}
      {key !== null && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate({ id: provider.id, patch: { apiKey: key } }, { onSuccess: () => setKey(null) });
          }}
        >
          <TextInput
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="New API key"
            aria-label="New API key"
            className="flex-1"
            autoFocus
          />
          <Button size="sm" type="submit" variant="primary" disabled={!key.trim()}>
            Save key
          </Button>
        </form>
      )}
    </li>
  );
}

function AddProvider({ presets, onDone }: { presets: ProviderPreset[]; onDone(): void }) {
  const add = useAddProvider();
  const [presetId, setPresetId] = useState(presets[0]!.preset);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const preset = presets.find((candidate) => candidate.preset === presetId)!;
  const showUrl = preset.needsBaseUrl || preset.group === "local";

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate(
          {
            preset: presetId,
            ...(label.trim() ? { label: label.trim() } : {}),
            ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          },
          { onSuccess: onDone },
        );
      }}
    >
      <Field label="Provider">
        <select
          className="select"
          value={presetId}
          onChange={(event) => {
            setPresetId(event.target.value);
            setBaseUrl("");
          }}
        >
          {GROUPS.map((group) => (
            <optgroup key={group.id} label={group.label}>
              {presets
                .filter((candidate) => candidate.group === group.id)
                .map((candidate) => (
                  <option key={candidate.preset} value={candidate.preset}>
                    {candidate.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </Field>
      {showUrl && (
        <Field label={preset.needsBaseUrl ? "Base URL" : "Base URL (optional)"}>
          <TextInput
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={preset.baseUrlHint ?? preset.baseUrl}
            required={preset.needsBaseUrl}
          />
        </Field>
      )}
      {(preset.needsKey || preset.group === "custom") && (
        <Field label={preset.needsKey ? "API key" : "API key (optional)"}>
          <TextInput
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            required={preset.needsKey}
            autoComplete="off"
          />
          {preset.keyUrl && (
            <a
              href={preset.keyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline"
            >
              Get a key <ExternalLink size={10} />
            </a>
          )}
        </Field>
      )}
      <Field label="Name (optional)">
        <TextInput
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={preset.label}
        />
      </Field>
      {add.error && <p className="text-xs text-danger">{add.error.message}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={add.isPending}>
          {add.isPending ? "Adding…" : "Add"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
