/**
 * Big results from connected apps, kept whole so a bot can read the part it needs.
 *
 * A search that returns 120 messages is 60,000 characters: it fills a small model's context, and cutting it at a
 * length leaves half a JSON document, which small models misread. Instead the bot is shown the result's structure (its
 * keys, how many items each list has, a short preview) and reads parts of it with `query_result`, by path.
 *
 * Results are kept per bot and per chat, so "from that list earlier" still works in the next message, and a bot can't
 * read another bot's results. They are bounded in number and size (the oldest go first), already scrubbed of
 * secrets, and dropped with the chat.
 */

/** A result longer than this is kept and summarized instead of shown whole. */
export const KEEP_OVER = 4_000;
/** Most of a kept result a query shows at once. */
export const QUERY_MAX = 6_000;

interface Kept {
  botId: string;
  threadId: string;
  label: string;
  text: string;
  /** The parsed value, when the result is JSON. */
  json: unknown;
}

const parseJson = (text: string): unknown => {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
};

export class ResultStore {
  /** In use order: the first is the one used longest ago. */
  private readonly kept = new Map<string, Kept>();
  private readonly counters = new Map<string, number>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = 100,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {}

  private static key(botId: string, threadId: string, id: string) {
    return `${botId}\u0000${threadId}\u0000${id}`;
  }

  /** Keeps a result and returns its id within this bot's chat ("r1", "r2", …). */
  put(botId: string, threadId: string, label: string, text: string): string {
    const scope = `${botId}\u0000${threadId}`;
    const n = (this.counters.get(scope) ?? 0) + 1;
    this.counters.set(scope, n);
    const id = `r${n}`;
    this.kept.set(ResultStore.key(botId, threadId, id), {
      botId,
      threadId,
      label,
      text,
      json: parseJson(text),
    });
    this.bytes += text.length;
    while (this.kept.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [oldest, entry] = this.kept.entries().next().value as [string, Kept];
      this.kept.delete(oldest);
      this.bytes -= entry.text.length;
    }
    return id;
  }

  /** A kept result of this bot in this chat; reading it makes it the last to go. */
  get(botId: string, threadId: string, id: string): Kept | null {
    const key = ResultStore.key(botId, threadId, id.trim().toLowerCase());
    const entry = this.kept.get(key);
    if (!entry) return null;
    this.kept.delete(key);
    this.kept.set(key, entry);
    return entry;
  }

  /** The ids and labels this bot has kept in this chat, newest first. */
  list(botId: string, threadId: string): { id: string; label: string }[] {
    const out: { id: string; label: string }[] = [];
    for (const [key, entry] of this.kept)
      if (entry.botId === botId && entry.threadId === threadId)
        out.push({ id: key.split("\u0000")[2]!, label: entry.label });
    return out.toReversed();
  }

  /** The chat was cleared or deleted. */
  dropThread(threadId: string): void {
    for (const [key, entry] of this.kept)
      if (entry.threadId === threadId) {
        this.kept.delete(key);
        this.bytes -= entry.text.length;
      }
    for (const scope of this.counters.keys())
      if (scope.endsWith(`\u0000${threadId}`)) this.counters.delete(scope);
  }

  /** The bot was deleted. */
  dropBot(botId: string): void {
    for (const [key, entry] of this.kept)
      if (entry.botId === botId) {
        this.kept.delete(key);
        this.bytes -= entry.text.length;
      }
  }
}

// ---- describing a value ---------------------------------------------------------------------------------------

/** A value's structure in a line: keys, list lengths, the first item's shape, short values as they are. */
export function shapeOf(value: unknown, depth = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.length} item${value.length === 1 ? "" : "s"}: ${depth >= 3 ? "…" : shapeOf(value[0], depth + 1)}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth >= 3) return `{${entries.length} keys}`;
    const shown = entries.slice(0, 15).map(([key, item]) => {
      const inner =
        item && typeof item === "object"
          ? `: ${shapeOf(item, depth + 1)}`
          : depth === 0
            ? `: ${shapeOf(item, depth + 1)}`
            : "";
      return `${key}${inner}`;
    });
    if (entries.length > shown.length) shown.push(`…${entries.length - shown.length} more`);
    return `{${shown.join(", ")}}`;
  }
  if (typeof value === "string")
    return value.length <= 40 ? JSON.stringify(value) : `text (${value.length} characters)`;
  return String(value);
}

/** A short taste of a value: lists cut to their first few items, long text shortened, still valid JSON. */
function preview(value: unknown, depth = 0): unknown {
  if (Array.isArray(value))
    return value.slice(0, depth === 0 ? 3 : 2).map((item) => preview(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 12)
        .map(([key, item]) => [key, preview(item, depth + 1)]),
    );
  if (typeof value === "string" && value.length > 120) return `${value.slice(0, 120)}…`;
  return value;
}

/** What the bot is shown instead of a big result. */
export function summary(id: string, label: string, kept: Pick<Kept, "text" | "json">): string {
  const size = `${kept.text.length.toLocaleString("en-US")} characters`;
  const head = `The result of ${label} is large (${size}), so it was kept as "${id}" instead of shown whole.`;
  if (kept.json !== undefined) {
    const taste = JSON.stringify(preview(kept.json));
    return [
      head,
      `Its shape: ${shapeOf(kept.json)}`,
      `A preview (lists cut to their first items): ${taste.length > 1500 ? `${taste.slice(0, 1500)}…` : taste}`,
      `Read the parts you need with query_result, id "${id}" and a path such as "items[0:10].name", "items[*].id" or "items[?status==open]".`,
    ].join("\n");
  }
  return [
    head,
    `The start of it:\n${kept.text.slice(0, 2_500)}`,
    `Read more with query_result, id "${id}": lines such as "100-200", or find with a word to search for.`,
  ].join("\n");
}

// ---- reading a part by path -------------------------------------------------------------------------------------

/**
 * A small path language, safe by construction (nothing in it can run code):
 *   key  .key  [3]  [-1]  [0:10]  [*]  [?field==value]  [?field!=value]  [?field~text]
 * After [*], a slice or a filter, what follows applies to each item: "messages[*].subject" is every subject.
 * Values in a filter may be numbers, true, false, null, or text (quoted or not); ~ matches text, ignoring case.
 */
export function queryPath(root: unknown, path: string): unknown {
  const tokens =
    /(?:^|\.)([A-Za-z_$][\w$-]*)|\[(-?\d+)\]|\[(-?\d*):(-?\d*)\]|\[(\*)\]|\[\?\s*([\w$.-]+)\s*(==|!=|~)\s*([^\]]*?)\s*\]/y;
  let current: unknown = root;
  let each = false;
  let at = 0;
  const trimmed = path.trim().replace(/^\$\.?/, "");
  while (at < trimmed.length) {
    tokens.lastIndex = at;
    const match = tokens.exec(trimmed);
    if (!match)
      throw new Error(
        `I can't read the path at "${trimmed.slice(at)}". Use keys, [n], [a:b], [*] or [?key==value].`,
      );
    at = tokens.lastIndex;
    const [, key, index, from, to, star, field, op, raw] = match;
    const step = (value: unknown): unknown => {
      if (key !== undefined)
        return value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)[key]
          : undefined;
      if (!Array.isArray(value)) return undefined;
      if (index !== undefined) return value.at(Number(index));
      if (star !== undefined) return value;
      if (field !== undefined) return value.filter((item) => matches(item, field, op!, raw!));
      return value.slice(from === "" ? undefined : Number(from), to === "" ? undefined : Number(to));
    };
    const listing = star !== undefined || field !== undefined || from !== undefined;
    if (each && Array.isArray(current)) {
      current = current.map(step);
      if (listing) current = (current as unknown[]).flat();
      if (index !== undefined || key !== undefined)
        current = (current as unknown[]).filter((item) => item !== undefined);
    } else current = step(current);
    if (listing) each = true;
  }
  return current;
}

function matches(item: unknown, field: string, op: string, raw: string): boolean {
  const value = field
    .split(".")
    .reduce<unknown>(
      (inner, key) =>
        inner && typeof inner === "object" ? (inner as Record<string, unknown>)[key] : undefined,
      item,
    );
  const wanted = /^(['"]).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
  if (op === "~") return typeof value === "string" && value.toLowerCase().includes(wanted.toLowerCase());
  const literal = /^(['"]).*\1$/.test(raw)
    ? wanted
    : wanted === "true"
      ? true
      : wanted === "false"
        ? false
        : wanted === "null"
          ? null
          : wanted !== "" && !Number.isNaN(Number(wanted))
            ? Number(wanted)
            : wanted;
  const equal = value === literal || (typeof value !== "object" && String(value) === String(literal));
  return op === "==" ? equal : !equal;
}

/** What query_result answers, at most QUERY_MAX characters. */
export function answerQuery(
  kept: Pick<Kept, "text" | "json">,
  options: { path?: string; find?: string; lines?: string },
): string {
  const cap = (text: string, hint: string) =>
    text.length <= QUERY_MAX
      ? text
      : `${text.slice(0, QUERY_MAX)}\n…(${text.length - QUERY_MAX} more characters: ${hint})`;
  if (options.find) {
    const needle = options.find.toLowerCase();
    const hits = kept.text
      .split(/\r?\n/)
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => line.toLowerCase().includes(needle));
    if (hits.length === 0) return `"${options.find}" doesn't appear in this result.`;
    const shown = hits
      .slice(0, 60)
      .map(([n, line]) => `${n}: ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
    return cap(
      `${hits.length} line${hits.length === 1 ? "" : "s"} contain "${options.find}":\n${shown.join("\n")}`,
      "search for something narrower",
    );
  }
  if (options.lines) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(options.lines);
    if (!match) return 'Give lines as "from-to", such as "100-200".';
    const all = kept.text.split(/\r?\n/);
    const from = Math.max(1, Number(match[1]));
    const to = Math.min(all.length, Number(match[2] ?? from + 99));
    return cap(
      `Lines ${from}-${to} of ${all.length}:\n${all.slice(from - 1, to).join("\n")}`,
      "ask for fewer lines",
    );
  }
  if (options.path) {
    if (kept.json === undefined)
      return "This result isn't JSON, so it has no paths: use lines or find instead.";
    const value = queryPath(kept.json, options.path);
    if (value === undefined) return `Nothing at "${options.path}". The result's shape: ${shapeOf(kept.json)}`;
    const text = JSON.stringify(value);
    return text.length <= QUERY_MAX
      ? text
      : cap(
          `Its shape: ${shapeOf(value)}\n${text}`,
          "use a narrower path, such as a slice [0:10] or a single field",
        );
  }
  return kept.json !== undefined
    ? `Its shape: ${shapeOf(kept.json)}`
    : cap(kept.text.slice(0, 2_500), 'use lines such as "100-200" or find');
}
