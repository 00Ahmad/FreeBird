import { mkdir, readdir, rename, rm, stat, appendFile } from "node:fs/promises";
import { join } from "node:path";

import { EPHEMERAL_EVENTS, type HarnessEvent } from "@mrog/shared";

import type { EventBus } from "./bus";

/**
 * A record of what happened, kept on disk, for working out what went wrong after a crash or a bad turn: every durable
 * event the harness published, one JSON object per line, one file per chat (`<data>/logs/thr_….ndjson`).
 *
 * Meant to be safe to leave on:
 *  - it never slows the app down: events are queued and written by one background writer, and when the writer falls
 *    behind the newest events are dropped (with a note in the log) instead of holding anything up;
 *  - secrets are redacted and pictures are left out before a line is written;
 *  - a file stops growing at a size limit (the older half goes to `.1`, and the one before that is deleted);
 *  - it is a copy of the chat, so it goes when the chat goes: "Clear chat" and deleting a chat or bot delete its log,
 *    and logs of chats that no longer exist are removed when the app starts.
 */

export interface EventLogOptions {
  dir: string;
  /** The harness's own token, never to be written down. */
  token: string;
  /** A file passes this size and it rotates. */
  maxFileBytes?: number;
  /** Takes the user's known secret values out of each line (the scrubber), on top of the patterns below. */
  scrub?: (line: string) => string;
  /** Queued lines (and bytes) beyond which new events are dropped. */
  maxQueueLines?: number;
  maxQueueBytes?: number;
  /** The chats that exist, to remove logs left behind by one that was deleted. */
  threadIds?: () => string[];
}

const APP_FILE = "_app";
const THREAD_FILE = /^thr_[0-9a-f]{32}$/;

const DEFAULTS = { maxFileBytes: 8 * 1024 * 1024, maxQueueLines: 2_000, maxQueueBytes: 16 * 1024 * 1024 };

/** Text that looks like a credential. Each replaces only the secret part, so a line stays valid JSON. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted key]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]"],
  // "password": "…" and the like, also when the whole thing sits inside an escaped string.
  [
    /((?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)\\?"\s*:\s*\\?")([^"\\]+)(\\?")/gi,
    "$1[redacted]$3",
  ],
];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Takes secrets out of a serialized line. */
export function redact(line: string, token?: string): string {
  let out = line;
  if (token && token.length >= 8) out = out.replace(new RegExp(escapeRegExp(token), "g"), "[redacted]");
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** An event as one log line: pictures and other bulky data left out, secrets redacted. */
export function serialize(event: HarnessEvent, token?: string): string {
  const line = JSON.stringify(event, (key, value: unknown) => {
    // Pictures the user attached and screenshots are base64; they say nothing about what went wrong.
    if (key === "data" && typeof value === "string" && value.length > 512)
      return `[${value.length} characters left out]`;
    if (typeof value === "string" && value.length > 50_000)
      return `${value.slice(0, 50_000)}…[${value.length - 50_000} more characters left out]`;
    return value;
  });
  return redact(line, token);
}

/** The chat an event belongs to, or null for events about the app as a whole. */
function threadOf(event: HarnessEvent): string | null {
  switch (event.type) {
    case "message.created":
    case "message.updated":
      return event.message.threadId;
    case "thread.created":
    case "thread.updated":
      return event.thread.id;
    case "thread.deleted":
      return event.threadId;
    case "data.changed":
      return event.threadId ?? null;
    case "discussion.updated":
      return event.discussion.threadId;
    case "race.updated":
      return event.race.threadId;
    default:
      return null;
  }
}

type Job = { kind: "write"; file: string; line: string } | { kind: "remove"; file: string };

export class EventLog {
  private readonly options: Required<Omit<EventLogOptions, "threadIds" | "scrub">> &
    Pick<EventLogOptions, "threadIds" | "scrub">;
  private readonly queue: Job[] = [];
  private queuedBytes = 0;
  private dropped = 0;
  private writer: Promise<void> | null = null;
  /** Sizes of files already written to, so rotation doesn't stat on every line. */
  private readonly sizes = new Map<string, number>();
  /** Chats whose log was removed because the chat is gone: nothing more is written for them. */
  private readonly gone = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private ready: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly bus: EventBus,
    options: EventLogOptions,
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Starts listening. Safe to call once. */
  start(): void {
    this.ready = this.prepare();
    this.unsubscribe = this.bus.subscribe((event) => this.record(event));
  }

  private async prepare() {
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    const alive = this.options.threadIds ? new Set(this.options.threadIds()) : null;
    if (!alive) return;
    // Logs of chats deleted while the app wasn't looking (or by a path that missed the event).
    for (const name of await readdir(this.options.dir).catch(() => [] as string[])) {
      const thread = /^(thr_[0-9a-f]{32})\.ndjson(\.1)?$/.exec(name)?.[1];
      if (thread && !alive.has(thread))
        await rm(join(this.options.dir, name), { force: true }).catch(() => {});
    }
  }

  private record(event: HarnessEvent) {
    if (this.closed) return;
    const thread = threadOf(event);

    if (event.type === "thread.deleted") {
      this.remove(event.threadId, true);
      return;
    }
    // "Clear chat": the log is a copy of the messages, so it goes with them.
    if (event.type === "data.changed" && event.threadId && event.keys.includes("messages")) {
      this.remove(event.threadId, false);
      return;
    }
    if (EPHEMERAL_EVENTS.has(event.type)) return;
    if (thread && this.gone.has(thread)) return;

    const name = thread && THREAD_FILE.test(thread) ? thread : APP_FILE;
    this.enqueue({
      kind: "write",
      file: `${name}.ndjson`,
      line: `${this.options.scrub ? this.options.scrub(serialize(event, this.options.token)) : serialize(event, this.options.token)}\n`,
    });
  }

  private enqueue(job: Job) {
    const size = job.kind === "write" ? Buffer.byteLength(job.line) : 0;
    if (
      job.kind === "write" &&
      (this.queue.length >= this.options.maxQueueLines ||
        this.queuedBytes + size > this.options.maxQueueBytes)
    ) {
      // Behind on writing: lose the newest events rather than hold up the app. The gap is noted in the log.
      this.dropped += 1;
      return;
    }
    this.queue.push(job);
    this.queuedBytes += size;
    this.writer ??= this.drain();
  }

  /** Deletes a chat's log, including lines still waiting to be written. */
  private remove(thread: string, forever: boolean) {
    if (!THREAD_FILE.test(thread)) return;
    if (forever) this.gone.add(thread);
    const file = `${thread}.ndjson`;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const job = this.queue[i]!;
      if (job.kind === "write" && job.file === file) {
        this.queuedBytes -= Buffer.byteLength(job.line);
        this.queue.splice(i, 1);
      }
    }
    // In order with the writes before it, so an append in flight can't bring the file back.
    this.enqueue({ kind: "remove", file });
  }

  private async drain() {
    try {
      await this.ready?.catch(() => {});
      for (;;) {
        if (this.queue.length === 0) {
          if (this.dropped === 0) break;
          // Caught up after falling behind: say how much was lost.
          const note = `${JSON.stringify({ type: "log.dropped", count: this.dropped, at: new Date().toISOString() })}\n`;
          this.dropped = 0;
          this.queue.push({ kind: "write", file: `${APP_FILE}.ndjson`, line: note });
          this.queuedBytes += Buffer.byteLength(note);
        }
        const job = this.queue.shift()!;
        if (job.kind === "write") this.queuedBytes -= Buffer.byteLength(job.line);
        try {
          if (job.kind === "remove") {
            await rm(join(this.options.dir, job.file), { force: true });
            await rm(join(this.options.dir, `${job.file}.1`), { force: true });
            this.sizes.delete(job.file);
          } else {
            await this.append(job.file, job.line);
          }
        } catch (error) {
          // A full disk or a locked file must not become the app's problem.
          console.warn("[eventlog] could not write", (error as Error).message);
        }
      }
    } finally {
      // Still in the same turn as the "nothing left" check above, so no job can be queued in between and stranded.
      this.writer = null;
    }
  }

  private async append(file: string, line: string) {
    const path = join(this.options.dir, file);
    let size = this.sizes.get(file);
    if (size === undefined) size = (await stat(path).catch(() => null))?.size ?? 0;
    if (size > 0 && size + Buffer.byteLength(line) > this.options.maxFileBytes) {
      // The older half is kept as `.1`, replacing the one before it.
      await rename(path, `${path}.1`).catch(() => {});
      size = 0;
    }
    await appendFile(path, line, { mode: 0o600 });
    this.sizes.set(file, size + Buffer.byteLength(line));
  }

  /** Waits until everything queued so far has been written. */
  async flush(): Promise<void> {
    await this.ready?.catch(() => {});
    while (this.writer) await this.writer;
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.flush();
    this.closed = true;
  }
}
