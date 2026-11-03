import { useState } from "react";

import type { BrowserSettings, SearchProvider } from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import { useBrowser, useBrowserActions } from "../../hooks/phase5";
import { Field, Section, TextInput } from "./parts";

const BRAVE_SECRET = "brave-search-api-key";

const SEARCH: { value: SearchProvider; label: string; hint: string }[] = [
  {
    value: "browser",
    label: "In the bots' browser",
    hint: "Bots search Bing or DuckDuckGo like a person. No key needed; works best with the window shown.",
  },
  {
    value: "brave",
    label: "Brave Search API",
    hint: "Fast and reliable, also with a hidden window. Needs a free or paid key from brave.com/search/api.",
  },
  { value: "searxng", label: "SearXNG", hint: "Your own private search server, with JSON output turned on." },
];

export function BrowserSettingsPage() {
  const { data } = useBrowser();
  const actions = useBrowserActions();
  const [key, setKey] = useState("");
  if (!data) return null;
  const { settings, status } = data;
  const save = (patch: Partial<BrowserSettings>) => actions.save.mutate({ ...settings, ...patch });

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Web browser for bots"
        description="Bots use a real browser on this computer, like you would: search, open sites, use their search boxes, click through. Each bot gets its own tab. Bots sign in with their own browser profile, not yours."
      >
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
          Let bots use the browser
        </label>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={settings.show} onChange={(e) => save({ show: e.target.checked })} />
          Show the browser window, so you can watch and take over
        </label>
        <p className="text-[12px] text-ink-3">
          When a site asks for a CAPTCHA, a sign-in or a payment, the bot stops and asks you to do it in the
          window. Bots never type passwords or card numbers, and buttons like “Buy” or “Send” ask you first.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Browser">
            <select
              className="select"
              value={settings.channel}
              onChange={(e) => save({ channel: e.target.value as BrowserSettings["channel"] })}
            >
              <option value="msedge">Microsoft Edge</option>
              <option value="chrome">Google Chrome</option>
            </select>
          </Field>
          <Field label="Window" control={false}>
            <div className="flex h-8 items-center gap-2">
              {status.running ? (
                <Button size="sm" variant="subtle" onClick={() => actions.close.mutate()}>
                  Close browser
                </Button>
              ) : (
                <Button size="sm" variant="subtle" onClick={() => actions.open.mutate()}>
                  Open browser
                </Button>
              )}
              <span className="text-[12px] text-ink-3">
                {status.running ? "Running" : "Starts when a bot needs it"}
              </span>
            </div>
          </Field>
        </div>
        {status.error && <p className="text-[12.5px] text-danger">{status.error}</p>}
        {actions.open.error && <p className="text-[12.5px] text-danger">{actions.open.error.message}</p>}
        <p className="text-[12px] text-ink-3">
          Open the browser yourself to sign in to sites the bots should use; the sign-ins are kept for them.
        </p>
        {status.tabs.length > 0 && (
          <ul className="flex flex-col gap-1 text-[12.5px]">
            {status.tabs.map((tab) => (
              <li key={tab.botId} className="truncate">
                <span className="font-medium">{tab.botName}</span>{" "}
                <span className="text-ink-3">{tab.title || tab.url}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Web search" description="Where the web_search tool gets results.">
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Web search">
          {SEARCH.map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5",
                settings.search === option.value
                  ? "border-accent bg-selected"
                  : "border-border hover:bg-hover",
              )}
            >
              <input
                type="radio"
                name="search-provider"
                className="mt-1"
                checked={settings.search === option.value}
                onChange={() => save({ search: option.value })}
              />
              <span>
                <span className="block text-[13.5px] font-medium">{option.label}</span>
                <span className="block text-[12.5px] text-ink-3">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {settings.search === "brave" && (
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!key.trim()) return;
              actions.saveKey.mutate(
                { name: BRAVE_SECRET, value: key.trim() },
                {
                  onSuccess: () => {
                    setKey("");
                    save({ braveSecret: BRAVE_SECRET });
                  },
                },
              );
            }}
          >
            <Field
              label="Brave Search API key"
              hint={
                settings.braveSecret
                  ? "A key is saved in your keychain. Enter a new one to replace it."
                  : undefined
              }
            >
              <TextInput
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={settings.braveSecret ? "••••••••" : "Paste the key"}
                autoComplete="off"
              />
            </Field>
            <Button size="sm" type="submit" disabled={!key.trim()}>
              Save key
            </Button>
          </form>
        )}
        {settings.search === "searxng" && (
          <Field label="SearXNG address">
            <TextInput
              defaultValue={settings.searxngUrl ?? ""}
              placeholder="http://127.0.0.1:8888"
              onBlur={(e) => save({ searxngUrl: e.target.value.trim() || null })}
            />
          </Field>
        )}
      </Section>
    </div>
  );
}
