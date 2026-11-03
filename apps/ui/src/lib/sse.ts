import { HarnessEvent } from "@mrog/shared";

interface SseFrame {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

/** Incremental text/event-stream parser (WHATWG rules for the fields we use). */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    // Normalize CRLF/CR, but keep a trailing CR: its LF may arrive in the next chunk.
    const keepCr = this.buffer.endsWith("\r");
    this.buffer =
      (keepCr ? this.buffer.slice(0, -1) : this.buffer).replace(/\r\n?/g, "\n") + (keepCr ? "\r" : "");
    const frames: SseFrame[] = [];
    let end: number;
    while ((end = this.buffer.indexOf("\n\n")) !== -1) {
      const frame = parseFrame(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 2);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

function parseFrame(raw: string): SseFrame | null {
  const data: string[] = [];
  const frame: Omit<SseFrame, "data"> = {};
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "id") frame.id = value;
    else if (field === "event") frame.event = value;
    else if (field === "retry" && /^\d+$/.test(value)) frame.retry = Number(value);
  }
  if (data.length === 0 && frame.retry === undefined) return null;
  return { ...frame, data: data.join("\n") };
}

export type StreamStatus = "connecting" | "online" | "offline";

interface ConnectOptions {
  url: string;
  token: string;
  /**
   * `resumed`: this connection asked to carry on from the last stored event, so the events it missed follow
   * the hello (or stream.resync, when they're gone).
   */
  onEvent(event: HarnessEvent, resumed: boolean): void;
  onStatus(status: StreamStatus): void;
  /** Reconnect when nothing arrives for this long (the harness heartbeats every 15 s). */
  staleMs?: number;
}

/** Keeps one authenticated event stream open, reconnecting with backoff and resuming via Last-Event-ID. */
export function connectEvents({
  url,
  token,
  onEvent,
  onStatus,
  staleMs = 45_000,
}: ConnectOptions): () => void {
  let stopped = false;
  let lastId: string | undefined;
  let retryMs = 2_000;
  let failures = 0;
  let controller: AbortController | null = null;
  let wait: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      const current = controller;
      let lastSeen = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastSeen > staleMs) current.abort();
      }, 5_000);
      onStatus("connecting");
      const resumed = Boolean(lastId);
      try {
        const res = await fetch(`${url}/api/events`, {
          headers: { authorization: `Bearer ${token}`, ...(lastId ? { "last-event-id": lastId } : {}) },
          signal: current.signal,
          cache: "no-store",
        });
        if (!res.ok || !res.body) throw new Error(`Event stream answered ${res.status}`);
        const parser = new SseParser();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          lastSeen = Date.now();
          for (const frame of parser.push(value)) {
            if (frame.retry !== undefined) retryMs = frame.retry;
            if (!frame.data) continue;
            const parsed = safeEvent(frame.data);
            if (!parsed) continue;
            if (frame.id) lastId = frame.id;
            if (parsed.type === "stream.hello") {
              failures = 0;
              onStatus("online");
            }
            onEvent(parsed, resumed);
          }
        }
      } catch {
        // Aborted, refused or dropped: fall through to the reconnect below.
      } finally {
        clearInterval(watchdog);
      }
      if (stopped) return;
      onStatus("offline");
      failures += 1;
      const delay = Math.min(retryMs * 2 ** Math.min(failures - 1, 4), 30_000);
      await new Promise((resolve) => (wait = setTimeout(resolve, delay)));
    }
  };

  void run();
  return () => {
    stopped = true;
    clearTimeout(wait);
    controller?.abort();
  };
}

function safeEvent(data: string): HarnessEvent | null {
  try {
    const parsed = HarnessEvent.safeParse(JSON.parse(data));
    if (parsed.success) return parsed.data;
    console.warn("[events] unknown event", parsed.error.issues);
  } catch {
    console.warn("[events] unreadable frame");
  }
  return null;
}
