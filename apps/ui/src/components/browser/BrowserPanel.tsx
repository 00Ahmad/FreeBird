import { CornerDownLeft, Globe, X } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent, type WheelEvent } from "react";

import type { Bot } from "@mrog/shared";
import { Button, cn, IconButton } from "@mrog/ui-kit";

import { useBrowser, useBrowserActions } from "../../hooks/phase5";
import { api } from "../../lib/api";
import { harnessInfo } from "../../lib/harness";
import { useUi } from "../../state";

/** How often a still picture is fetched while the live stream is quiet. */
const REFRESH_MS = 1000;
/** The stream counts as quiet after this long without a frame. */
const STILL_AFTER_MS = 2000;

/**
 * The bots' browser, live in the right panel (video while the page changes): watch a bot's tab and take over
 * right here (click, type, scroll), including when the browser window is hidden. Shows this chat's bot and its
 * helpers.
 */
export function BrowserPanel({ bot }: { bot: Bot }) {
  const { data } = useBrowser();
  const setPanel = useUi((state) => state.setPanel);
  const tabs = data?.status.tabs ?? [];
  // This chat's bot first, then its helpers and anyone else with a tab open.
  const [picked, setPicked] = useState<string | null>(null);
  const tab = tabs.find((t) => t.botId === picked) ?? tabs.find((t) => t.botId === bot.id) ?? tabs[0] ?? null;
  const ownTab = tabs.some((t) => t.botId === bot.id);
  const perBot = data?.settings.profiles === "per-bot";

  return (
    <aside
      className="flex h-full w-[46%] min-w-80 shrink-0 flex-col border-l border-border bg-surface"
      aria-label="Browser"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Globe size={15} className="text-ink-2" />
        <h2 className="flex-1 text-[14px] font-semibold">Browser</h2>
        <IconButton label="Close" onClick={() => setPanel("browser")}>
          <X size={14} />
        </IconButton>
      </div>
      {tabs.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-border px-3 py-1.5" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.botId}
              type="button"
              role="tab"
              aria-selected={t.botId === tab?.botId}
              onClick={() => setPicked(t.botId)}
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-[12px]",
                t.botId === tab?.botId ? "bg-selected text-ink" : "text-ink-3 hover:bg-hover",
              )}
            >
              {t.botName}
            </button>
          ))}
        </div>
      )}
      {tab && !ownTab && data?.settings.enabled && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
          <OpenForSignIn bot={bot} perBot={perBot} compact />
        </div>
      )}
      {tab ? (
        <LiveTab key={tab.botId} botId={tab.botId} url={tab.url} title={tab.title} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <Globe size={22} className="text-ink-3" />
          <p className="text-[13px] text-ink-2">
            No bot is browsing right now. When {bot.name} or its helpers open a page, it shows here live.
          </p>
          {data?.settings.enabled && <OpenForSignIn bot={bot} perBot={perBot} />}
        </div>
      )}
    </aside>
  );
}

/**
 * Opens this chat's bot's own tab, so the user can sign in to sites for it. With per-bot profiles the sign-ins
 * stay with this bot (and its helpers); with a shared profile every bot can use them.
 */
function OpenForSignIn({ bot, perBot, compact = false }: { bot: Bot; perBot: boolean; compact?: boolean }) {
  const { open } = useBrowserActions();
  return (
    <div className={cn("flex flex-col gap-1.5", compact ? "w-full" : "mt-2 items-center")}>
      <div className={cn("flex items-center gap-2", compact && "w-full")}>
        <Button size="sm" variant="subtle" disabled={open.isPending} onClick={() => open.mutate(bot.id)}>
          Open {bot.name}'s browser
        </Button>
        {compact && (
          <span className="truncate text-[12px] text-ink-3">to sign in to sites for {bot.name}</span>
        )}
      </div>
      {!compact && (
        <p className="max-w-72 text-[12px] text-ink-3">
          {perBot
            ? `Sign in to sites there and ${bot.name} stays signed in. Other bots don't get these sign-ins.`
            : "Sign in to sites there and the bots stay signed in. All bots share these sign-ins."}
        </p>
      )}
      {open.error && <p className="text-[12px] text-danger">{open.error.message}</p>}
    </div>
  );
}

function LiveTab({ botId, url, title }: { botId: string; url: string; title: string }) {
  const [picture, setPicture] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [address, setAddress] = useState("");
  const [live, setLive] = useState(false);
  const refresh = useRef<() => void>(() => {});
  const lastScroll = useRef(0);

  // Live video from the harness; when the page sits still the stream goes quiet, so a still picture is fetched
  // now and then (and the stream is reopened if it drops).
  useEffect(() => {
    let stopped = false;
    let current: string | null = null;
    let lastFrame = 0;
    const abort = new AbortController();
    const show = (blob: Blob) => {
      const next = URL.createObjectURL(blob);
      if (stopped) return URL.revokeObjectURL(next);
      if (current) URL.revokeObjectURL(current);
      current = next;
      setPicture(next);
    };
    const load = async () => {
      const harness = harnessInfo();
      if (!harness || stopped) return;
      try {
        const res = await fetch(`${harness.url}/api/browser/tabs/${botId}/view`, {
          headers: { authorization: `Bearer ${harness.token}` },
        });
        if (res.ok) show(await res.blob());
      } catch {
        // The next tick tries again.
      }
    };
    const stream = async () => {
      while (!stopped) {
        const harness = harnessInfo();
        try {
          const res = harness
            ? await fetch(`${harness.url}/api/browser/tabs/${botId}/stream`, {
                headers: { authorization: `Bearer ${harness.token}` },
                signal: abort.signal,
              })
            : null;
          if (res?.ok && res.body) {
            const reader = res.body.getReader();
            let buffer = new Uint8Array(0);
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              const joined = new Uint8Array(buffer.length + value.length);
              joined.set(buffer);
              joined.set(value, buffer.length);
              buffer = joined;
              while (buffer.length >= 4) {
                const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
                if (buffer.length < 4 + length) break;
                show(new Blob([buffer.slice(4, 4 + length)], { type: "image/jpeg" }));
                lastFrame = Date.now();
                setLive(true);
                buffer = buffer.slice(4 + length);
              }
            }
          }
        } catch {
          if (stopped) return;
        }
        setLive(false);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    };
    refresh.current = () => void load();
    void load();
    void stream();
    const timer = setInterval(() => {
      if (Date.now() - lastFrame > STILL_AFTER_MS) void load();
    }, REFRESH_MS);
    return () => {
      stopped = true;
      abort.abort();
      clearInterval(timer);
      if (current) URL.revokeObjectURL(current);
    };
  }, [botId]);

  const act = async (path: string, body: unknown) => {
    setError(null);
    try {
      await api(`/browser/tabs/${botId}/${path}`, { method: "POST", body });
    } catch (caught) {
      setError((caught as Error).message);
    }
    setTimeout(() => refresh.current(), 300);
  };

  const click = (event: MouseEvent<HTMLImageElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    void act("click", {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    });
  };

  const wheel = (event: WheelEvent<HTMLImageElement>) => {
    if (Date.now() - lastScroll.current < 250) return;
    lastScroll.current = Date.now();
    void act("scroll", { dy: Math.max(-1500, Math.min(1500, event.deltaY * 2)) });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="truncate border-b border-border px-4 py-1.5 text-[12px] text-ink-3" title={url}>
        {live && <span className="mr-1.5 font-medium text-danger">● Live</span>}
        {title ? `${title} · ` : ""}
        {url}
      </div>
      <form
        className="flex items-center gap-1.5 border-b border-border px-3 py-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const typed = address.trim();
          if (!typed) return;
          void act("go", { url: /^https?:\/\//i.test(typed) ? typed : `https://${typed}` });
          setAddress("");
        }}
      >
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="Go to an address, e.g. to sign in"
          aria-label="Open an address in this tab"
          className="h-7 min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 text-[12.5px] outline-none focus:border-accent"
        />
        <Button size="sm" variant="subtle" type="submit" disabled={!address.trim()}>
          Go
        </Button>
      </form>
      <div className="min-h-0 flex-1 overflow-auto bg-bg p-2">
        {picture ? (
          <img
            src={picture}
            alt={`Live view of ${title || url}`}
            onClick={click}
            onWheel={wheel}
            className="w-full cursor-pointer rounded-md border border-border"
            draggable={false}
          />
        ) : (
          <p className="p-4 text-[13px] text-ink-3">Loading…</p>
        )}
      </div>
      <form
        className="flex items-center gap-1.5 border-t border-border px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          void act("type", { text, key: "Enter" });
          setText("");
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Click a box in the page, then type here"
          aria-label="Type into the page"
          className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 text-[13px] outline-none focus:border-accent"
        />
        <Button
          size="sm"
          type="button"
          disabled={!text}
          onClick={() => (void act("type", { text }), setText(""))}
        >
          Type
        </Button>
        <IconButton label="Type and press Enter" type="submit">
          <CornerDownLeft size={14} />
        </IconButton>
      </form>
      {error && <p className="px-3 pb-2 text-[12px] text-danger">{error}</p>}
      <p className="px-3 pb-2 text-[11.5px] text-ink-3">
        Click in the picture to click in the page; scroll over it to scroll. What you do here happens in the
        bot's tab.
      </p>
    </div>
  );
}
