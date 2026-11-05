import {
  ChevronDown,
  ChevronRight,
  CreditCard,
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  User,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import type { ConnectorView, NewVaultItem } from "@mrog/shared";
import { Button, cn, IconButton } from "@mrog/ui-kit";

import {
  useConnectorActions,
  useConnectors,
  useSaveVoice,
  useVault,
  useVaultActions,
  useVoiceSettings,
} from "../../hooks/phase5";
import { useProviders } from "../../hooks/providers";
import { Field, Section, TextInput } from "./parts";

// ---- Connect apps --------------------------------------------------------------------------------------
const STATE_LABEL: Record<ConnectorView["state"], string> = {
  off: "Off",
  connecting: "Connecting…",
  connected: "Connected",
  error: "Disconnected",
  auth: "Needs you to sign in",
};

export function AppsSettings() {
  const { data: connectors } = useConnectors();
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Connected apps"
        description="Any MCP server: a local program (stdio) or a remote URL (HTTP). Bots ask before using an app unless you turn that off. Use vault:NAME for keys."
      >
        <ul className="flex flex-col gap-2">
          {connectors?.map((connector) => (
            <ConnectorRow key={connector.id} connector={connector} />
          ))}
        </ul>
        {connectors?.length === 0 && !adding && <p className="text-[13px] text-ink-3">No apps yet.</p>}
        {adding ? (
          <AddConnector onDone={() => setAdding(false)} />
        ) : (
          <div>
            <Button onClick={() => setAdding(true)}>
              <Plus size={14} /> Add app
            </Button>
          </div>
        )}
      </Section>
    </div>
  );
}

/**
 * An app that wants the user to sign in. The page opens in the system browser only when the button is pressed; the
 * address is also shown as a link, for a browser that blocks the new window.
 */
function SignInRow({ connector }: { connector: ConnectorView }) {
  const { signIn } = useConnectorActions();
  const [url, setUrl] = useState<string | null>(null);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-ink-2">{connector.name} asks you to sign in before bots can use it.</span>
      <Button
        size="sm"
        variant="primary"
        disabled={signIn.isPending}
        onClick={() =>
          signIn.mutate(connector.id, {
            onSuccess: (outcome) => {
              if (!("url" in outcome)) return;
              setUrl(outcome.url);
              window.open(outcome.url, "_blank", "noopener");
            },
          })
        }
      >
        {signIn.isPending ? "Opening…" : "Sign in"}
      </Button>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-accent underline">
          Open the sign-in page
        </a>
      )}
      {signIn.isError && <span className="text-danger">{signIn.error.message}</span>}
    </div>
  );
}

function ConnectorRow({ connector }: { connector: ConnectorView }) {
  const client = useQueryClient();
  const { update, reconnect, remove } = useConnectorActions();
  const [open, setOpen] = useState(false);
  // Tool switches the server hasn't confirmed yet. Each save sends all of them on top of the last known list, so
  // quick toggles add up instead of each one starting from data that predates the others.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const saving = useRef(0);
  const toolEnabled = (tool: ConnectorView["tools"][number]) => pending[tool.name] ?? tool.enabled;
  const enabledCount = connector.tools.filter(toolEnabled).length;
  const toggleTool = (name: string, enabled: boolean) => {
    const next = { ...pending, [name]: enabled };
    setPending(next);
    const disabled = new Set(connector.disabledTools);
    for (const [tool, on] of Object.entries(next)) {
      if (on) disabled.delete(tool);
      else disabled.add(tool);
    }
    saving.current += 1;
    void update
      .mutateAsync({ id: connector.id, patch: { disabledTools: [...disabled] } })
      .catch(() => {})
      .then(async () => {
        // Once the last save lands and the list is refetched, the server's answer takes over again.
        if (--saving.current > 0) return;
        await client.invalidateQueries({ queryKey: ["connectors"] });
        if (saving.current === 0) setPending({});
      });
  };
  return (
    <li className="rounded-xl border border-border px-3 py-2.5 text-[13px]">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="font-medium">{connector.name}</span>
          <span
            className={cn(
              "text-xs",
              connector.state === "connected"
                ? "text-success"
                : connector.state === "error"
                  ? "text-danger"
                  : "text-ink-3",
            )}
          >
            {connector.error?.startsWith("Needs auth") ? "Needs auth" : STATE_LABEL[connector.state]}
          </span>
          {connector.state === "connected" && (
            <span className="text-xs text-ink-3">
              {enabledCount} of {connector.tools.length} tools
            </span>
          )}
        </button>
        <label className="flex items-center gap-1 text-xs text-ink-2" title="Ask before each use">
          <input
            type="checkbox"
            checked={connector.askBeforeUse}
            onChange={(event) =>
              update.mutate({ id: connector.id, patch: { askBeforeUse: event.target.checked } })
            }
          />
          Ask first
        </label>
        <label className="flex items-center gap-1 text-xs text-ink-2">
          <input
            type="checkbox"
            checked={connector.enabled}
            onChange={(event) =>
              update.mutate({ id: connector.id, patch: { enabled: event.target.checked } })
            }
          />
          On
        </label>
        <IconButton label="Reconnect" onClick={() => reconnect.mutate(connector.id)}>
          <RefreshCw size={14} className={reconnect.isPending ? "animate-spin" : ""} />
        </IconButton>
        <IconButton
          label={`Remove ${connector.name}`}
          onClick={() => window.confirm(`Remove ${connector.name}?`) && remove.mutate(connector.id)}
        >
          <Trash2 size={14} />
        </IconButton>
      </div>
      {connector.state === "auth" ? (
        <SignInRow connector={connector} />
      ) : (
        connector.error && <p className="mt-1 text-xs text-danger">{connector.error}</p>
      )}
      {open && (
        <ul className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
          {connector.tools.map((tool) => (
            <li key={tool.name}>
              <label className="flex items-start gap-2 text-[12.5px]">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={toolEnabled(tool)}
                  onChange={(event) => toggleTool(tool.name, event.target.checked)}
                />
                <span>
                  <span className="font-mono">{tool.name}</span>
                  {tool.description && <span className="block text-ink-3">{tool.description}</span>}
                </span>
              </label>
            </li>
          ))}
          {connector.tools.length === 0 && <li className="text-xs text-ink-3">No tools (connect first).</li>}
        </ul>
      )}
    </li>
  );
}

function AddConnector({ onDone }: { onDone(): void }) {
  const { add } = useConnectorActions();
  const [name, setName] = useState("");
  const [type, setType] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("npx");
  const [args, setArgs] = useState("-y @modelcontextprotocol/server-filesystem C:\\Users");
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const pairs = (text: string) =>
    Object.fromEntries(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          // NAME=value or Name: value; a line without either isn't a pair.
          const at = line.search(/[=:]/);
          return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1).trim()]] : [];
        }),
    );
  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate(
          {
            name: name.trim(),
            askBeforeUse: true,
            transport:
              type === "stdio"
                ? {
                    type,
                    command: command.trim(),
                    args: args.match(/"[^"]*"|\S+/g)?.map((arg) => arg.replace(/^"|"$/g, "")) ?? [],
                    env: pairs(env),
                  }
                : { type, url: url.trim(), headers: pairs(headers) },
          },
          { onSuccess: onDone },
        );
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <TextInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="GitHub"
            required
          />
        </Field>
        <Field label="How it runs">
          <select
            className="select"
            value={type}
            onChange={(event) => setType(event.target.value as "stdio" | "http")}
          >
            <option value="stdio">Program on this computer (stdio)</option>
            <option value="http">Remote server (HTTP)</option>
          </select>
        </Field>
      </div>
      {type === "stdio" ? (
        <>
          <div className="grid grid-cols-[1fr_2fr] gap-3">
            <Field label="Command">
              <TextInput value={command} onChange={(event) => setCommand(event.target.value)} required />
            </Field>
            <Field label="Arguments">
              <TextInput value={args} onChange={(event) => setArgs(event.target.value)} />
            </Field>
          </div>
          <Field
            label="Environment (one NAME=value per line)"
            hint="Use vault:NAME to pull a key from the vault."
          >
            <textarea
              value={env}
              onChange={(event) => setEnv(event.target.value)}
              rows={2}
              className="rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
              placeholder="GITHUB_TOKEN=vault:GITHUB_TOKEN"
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL">
            <TextInput
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/mcp"
              required
            />
          </Field>
          <Field label="Headers (one Name: value per line)">
            <textarea
              value={headers}
              onChange={(event) => setHeaders(event.target.value)}
              rows={2}
              className="rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
              placeholder="Authorization: Bearer vault:MY_TOKEN"
            />
          </Field>
        </>
      )}
      {add.error && <p className="text-xs text-danger">{add.error.message}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={add.isPending}>
          {add.isPending ? "Connecting…" : "Add"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---- Vault ---------------------------------------------------------------------------------------------
const ICONS = { login: <KeyRound size={14} />, card: <CreditCard size={14} />, contact: <User size={14} /> };

export function VaultSettings() {
  const { data: items } = useVault();
  const { add, importCsv, remove } = useVaultActions();
  const [kind, setKind] = useState<NewVaultItem["kind"] | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [subdomains, setSubdomains] = useState(false);
  const set = (key: string) => (event: { target: { value: string } }) =>
    setFields((current) => ({ ...current, [key]: event.target.value }));

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Saved items"
        description="Values stay in your system keychain. Bots get logins as environment variables for commands and never see passwords or card numbers."
      >
        <ul className="flex flex-col gap-1.5">
          {items?.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-2.5 rounded-xl border border-border px-3 py-2 text-[13px]"
            >
              <span className="text-ink-2">{ICONS[item.kind]}</span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {item.label}
                {item.subdomains && (
                  <span className="ml-1.5 text-xs font-normal text-ink-3" title="Also used on its subdomains">
                    + subdomains
                  </span>
                )}
              </span>
              <span className="text-xs text-ink-3">
                {item.username ?? (item.last4 ? `•••• ${item.last4}` : item.kind)}
              </span>
              <IconButton
                label={`Remove ${item.label}`}
                onClick={() => window.confirm(`Remove ${item.label}?`) && remove.mutate(item.id)}
              >
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
          {items?.length === 0 && <li className="text-[13px] text-ink-3">Nothing saved yet.</li>}
        </ul>
        <div className="flex flex-wrap gap-2">
          {(["login", "card", "contact"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              onClick={() => (setKind(option), setFields({}), setSubdomains(false))}
            >
              <Plus size={13} /> {option === "login" ? "Login" : option === "card" ? "Card" : "Contact info"}
            </Button>
          ))}
          <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-ink-2 hover:bg-hover">
            <Upload size={13} /> Import from CSV…
            <input
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 5 * 1024 * 1024) return window.alert("The CSV must be under 5 MB.");
                importCsv.mutate(await file.text(), {
                  onSuccess: (result) =>
                    window.alert(
                      `Imported ${result.imported}, skipped ${result.skipped}. Delete the CSV now: it holds passwords unencrypted.`,
                    ),
                });
                event.target.value = "";
              }}
            />
          </label>
        </div>
        {importCsv.error && <p className="text-xs text-danger">{importCsv.error.message}</p>}
        {kind && (
          <form
            className="flex flex-col gap-2.5 rounded-xl border border-border p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const item = { kind, ...fields, ...(kind === "login" && subdomains ? { subdomains } : {}) };
              add.mutate(item as NewVaultItem, { onSuccess: () => setKind(null) });
            }}
          >
            {kind === "login" && (
              <>
                <Field label="Website">
                  <TextInput
                    value={fields.website ?? ""}
                    onChange={set("website")}
                    placeholder="https://github.com"
                    required
                  />
                </Field>
                <Field label="Username or email">
                  <TextInput value={fields.username ?? ""} onChange={set("username")} required />
                </Field>
                <Field label="Password">
                  <TextInput
                    type="password"
                    value={fields.password ?? ""}
                    onChange={set("password")}
                    required
                    autoComplete="new-password"
                  />
                </Field>
                <label className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={subdomains}
                    onChange={(event) => setSubdomains(event.target.checked)}
                  />
                  Also use on subdomains (like accounts.github.com)
                </label>
              </>
            )}
            {kind === "card" && (
              <>
                <Field label="Name on card">
                  <TextInput value={fields.name ?? ""} onChange={set("name")} required />
                </Field>
                <div className="grid grid-cols-[2fr_1fr_1fr] gap-2">
                  <Field label="Number">
                    <TextInput
                      value={fields.number ?? ""}
                      onChange={set("number")}
                      inputMode="numeric"
                      required
                    />
                  </Field>
                  <Field label="Expiry">
                    <TextInput
                      value={fields.expiry ?? ""}
                      onChange={set("expiry")}
                      placeholder="MM/YY"
                      required
                    />
                  </Field>
                  <Field label="CVC">
                    <TextInput
                      type="password"
                      value={fields.cvc ?? ""}
                      onChange={set("cvc")}
                      inputMode="numeric"
                      required
                    />
                  </Field>
                </div>
              </>
            )}
            {kind === "contact" && (
              <>
                <Field label="Name">
                  <TextInput value={fields.name ?? ""} onChange={set("name")} required />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Email">
                    <TextInput value={fields.email ?? ""} onChange={set("email")} />
                  </Field>
                  <Field label="Phone">
                    <TextInput value={fields.phone ?? ""} onChange={set("phone")} />
                  </Field>
                </div>
                <Field label="Address">
                  <TextInput value={fields.address ?? ""} onChange={set("address")} />
                </Field>
              </>
            )}
            <Field label="Hints (optional)" hint="Helps the bot pick the right entry.">
              <TextInput value={fields.hints ?? ""} onChange={set("hints")} />
            </Field>
            {add.error && <p className="text-xs text-danger">{add.error.message}</p>}
            <div className="flex gap-2">
              <Button type="submit" variant="primary">
                Save {kind === "login" ? "login" : kind === "card" ? "card" : "contact info"}
              </Button>
              <Button variant="ghost" onClick={() => setKind(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Section>
    </div>
  );
}

// ---- Voice ---------------------------------------------------------------------------------------------
export function VoiceSettingsPage() {
  const { data: settings } = useVoiceSettings();
  const { data: providers } = useProviders();
  const save = useSaveVoice();
  const candidates = (providers?.providers ?? []).filter((provider) => provider.kind === "openai");
  if (!settings) return null;
  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Dictation (speech to text)"
        description="Uses any OpenAI-compatible transcription endpoint: OpenAI (whisper-1), Groq (whisper-large-v3), or a local whisper server added as a provider."
      >
        {candidates.length === 0 ? (
          <p className="text-[13px] text-ink-3">Add a provider in Models & Providers first.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Provider">
              <select
                className="select"
                value={settings.sttProvider ?? ""}
                onChange={(event) => save.mutate({ ...settings, sttProvider: event.target.value || null })}
              >
                <option value="">Off</option>
                {candidates.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model">
              <TextInput
                defaultValue={settings.sttModel ?? ""}
                placeholder="whisper-large-v3"
                onBlur={(event) => save.mutate({ ...settings, sttModel: event.target.value.trim() || null })}
              />
            </Field>
          </div>
        )}
      </Section>
      <Section
        title="Read aloud"
        description="Bot replies have a speaker button that reads them with your computer's built-in voices. Nothing leaves this computer."
      >
        <p className="text-[12.5px] text-ink-3">
          {typeof speechSynthesis !== "undefined"
            ? `${speechSynthesis.getVoices().length || "Default"} voices available.`
            : "Not available here."}
        </p>
      </Section>
    </div>
  );
}
