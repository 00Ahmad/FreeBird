import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { BADGES, safe, type Risk } from "./types";

const MAX_CHARS = 20_000;

/** Hosts on this machine or the local network: fetching them needs approval. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host === "home.arpa" ||
    host.endsWith(".home.arpa")
  ) {
    return true;
  }
  // A name without a dot (nas, router) only means something on the local network.
  if (host && !isIP(host) && !host.includes(".")) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(host) === 6) {
    // An IPv4 address written as IPv6 (::ffff:127.0.0.1, which URLs turn into ::ffff:7f00:1).
    const mapped = /^::ffff:(?:([\d.]+)|([\da-f]{1,4}):([\da-f]{1,4}))$/.exec(host);
    if (mapped) {
      if (mapped[1]) return isPrivateHost(mapped[1]);
      const high = Number.parseInt(mapped[2]!, 16);
      const low = Number.parseInt(mapped[3]!, 16);
      return isPrivateHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return host === "::" || host === "::1" || /^(fc|fd|fe[89ab]|fe[c-f])/.test(host);
  }
  return false;
}

/** Whether a host name points at this machine or the local network once looked up (e.g. 127.0.0.1.nip.io). */
export async function resolvesPrivately(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPrivateHost(host);
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.some((entry) => isPrivateHost(entry.address));
  } catch {
    // Unknown names fail when fetched; that error explains it better.
    return false;
  }
}

export const isWebUrl = (value: string): boolean => {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
};

/** Arguments of calls whose address was local when judged: those calls asked first, so they may go there. */
const judgedLocal = new WeakSet<object>();

/**
 * Opening or fetching an address asks first when it is on this computer or the local network: written as one
 * (192.168.1.1, nas, router.lan) or a name that turns out to be one when looked up. Anything not http(s) is
 * refused when run, so it needs no question.
 */
export async function addressRisk(args: object, url: string, summary: string): Promise<Risk> {
  if (!isWebUrl(url)) return safe(summary);
  const { hostname } = new URL(url);
  if (!isPrivateHost(hostname) && !(await resolvesPrivately(hostname))) return safe(summary);
  judgedLocal.add(args);
  return { level: "ask", kind: "general", badges: [BADGES.network], summary };
}

/**
 * Whether a call may reach the local network: its address is written as a local one (which always asks), or was
 * found local when the call was judged. A name that looked public then isn't trusted now, even if it has changed.
 */
export function mayReachLocal(args: object, url: string): boolean {
  return judgedLocal.has(args) || (isWebUrl(url) && isPrivateHost(new URL(url).hostname));
}

/** Largest response body read, so a huge download can't fill the harness's memory. */
const MAX_BODY_BYTES = 5_000_000;

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    if (size >= MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(parts).subarray(0, MAX_BODY_BYTES));
}

const attr = (attrs: string, name: string) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return match ? (match[1] ?? match[2]) : undefined;
};

/**
 * Most of a page that is turned into text. Anything past it is dropped (and the text says so), so a huge or hostile
 * page can't hold up the harness, which every bot, the chat stream and the Stop button share.
 */
const MAX_HTML_CHARS = 400_000;

const BLOCK_TAGS = "script|style|noscript|svg|head";

/**
 * Where `<name …>…</name>` blocks sit in a page, as [start, end) pairs. Done in one pass: an opening tag with no
 * closing one is left alone, and that is found out once per name rather than once per opening tag, so a page made of
 * unclosed tags can't make the search quadratic.
 */
function blockSpans(html: string, names: string): [number, number][] {
  const opening = new RegExp(`<(${names})`, "gi");
  const closers = new Map<string, RegExp>();
  const unclosed = new Set<string>();
  const spans: [number, number][] = [];
  // The first ">" at or after the last place looked, kept so opening tags that share it don't each search for it.
  let gt = -1;
  for (;;) {
    const found = opening.exec(html);
    if (!found) break;
    const name = found[1]!.toLowerCase();
    if (unclosed.has(name)) continue;
    if (gt < opening.lastIndex) {
      gt = html.indexOf(">", opening.lastIndex);
      // No ">" left: nothing after this can be a tag.
      if (gt === -1) break;
    }
    let closer = closers.get(name);
    if (!closer) closers.set(name, (closer = new RegExp(`</${name}>`, "gi")));
    closer.lastIndex = gt + 1;
    if (!closer.exec(html)) {
      unclosed.add(name);
      continue;
    }
    spans.push([found.index, closer.lastIndex]);
    opening.lastIndex = closer.lastIndex;
  }
  return spans;
}

/** The page without its scripts, styles, hidden parts and inline pictures. */
function withoutBlocks(html: string): string {
  let out = "";
  let from = 0;
  for (const [start, end] of blockSpans(html, BLOCK_TAGS)) {
    out += `${html.slice(from, start)} `;
    from = end;
  }
  return out + html.slice(from);
}

/** Replaces every tag with a space. A "<" with no ">" after it is just text. */
function stripTags(html: string): string {
  let out = "";
  let from = 0;
  let at = 0;
  for (;;) {
    const open = html.indexOf("<", at);
    const close = open === -1 ? -1 : html.indexOf(">", open + 1);
    if (close === -1) break;
    // "<>" is not a tag.
    if (close === open + 1) {
      at = close;
      continue;
    }
    out += `${html.slice(from, open)} `;
    from = at = close + 1;
  }
  return out + html.slice(from);
}

const LINK = /^<a\s[^>]*href="([^"]+)"[^>]*>$/i;

/** What one tag turns into: a form or field is described, a line break becomes one, anything else is dropped. */
function tagText(tag: string): string {
  const form = /^<form\b([^>]*)>$/i.exec(tag);
  if (form) {
    const method = (attr(form[1]!, "method") ?? "get").toUpperCase();
    return `\n[form: ${method} ${attr(form[1]!, "action") || "(this page)"}]\n`;
  }
  const field = /^<(input|textarea|select)\b([^>]*)>$/i.exec(tag);
  if (field) {
    const [, name, attrs] = field as unknown as [string, string, string];
    const type = (attr(attrs, "type") ?? (name.toLowerCase() === "input" ? "text" : name)).toLowerCase();
    if (/^(hidden|submit|button|image|reset)$/.test(type)) return " ";
    const label = attr(attrs, "aria-label") ?? attr(attrs, "placeholder");
    const fieldName = attr(attrs, "name");
    return ` [${type} field${label ? ` "${label}"` : ""}${fieldName ? ` name=${fieldName}` : ""}] `;
  }
  if (/^<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)/i.test(tag)) return "\n";
  if (/^<li/i.test(tag)) return "- ";
  return " ";
}

/**
 * Every tag in one left-to-right pass, so the time taken grows with the page and not with how its tags are broken.
 * A link shows its target after its text: `<a href="/x">Shop</a>` becomes `Shop (/x)`.
 */
function markupToText(html: string): string {
  const parts: string[] = [];
  // The link being read: where its opening tag sits in `parts`, and where it points.
  let link: { slot: number; url: string } | undefined;
  let from = 0;
  let at = 0;
  for (;;) {
    const open = html.indexOf("<", at);
    const close = open === -1 ? -1 : html.indexOf(">", open + 1);
    // A "<" with no ">" after it, and everything after, is text.
    if (close === -1) break;
    // "<>" is not a tag.
    if (close === open + 1) {
      at = close;
      continue;
    }
    parts.push(html.slice(from, open));
    const tag = html.slice(open, close + 1);
    if (link && /^<\/a>$/i.test(tag)) {
      parts[link.slot] = "";
      parts.push(` (${link.url})`);
      link = undefined;
    } else {
      const opens = link ? null : LINK.exec(tag);
      // Dropped like any tag unless its closing tag turns up, in which case the text between them is the link's.
      if (opens) link = { slot: parts.length, url: opens[1]! };
      parts.push(opens ? " " : tagText(tag));
    }
    from = at = close + 1;
  }
  parts.push(html.slice(from));
  return parts.join("");
}

/**
 * Readable text from an HTML page: drops scripts, styles and tags, keeps link targets, and shows forms and their
 * fields (a site's search box is how a person finds things there).
 */
export function htmlToText(html: string): string {
  const page = withoutBlocks(html);
  const cut = page.length > MAX_HTML_CHARS;
  const text = markupToText(cut ? page.slice(0, MAX_HTML_CHARS) : page)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  return cut ? `${text}\n…(page cut at ${MAX_HTML_CHARS} characters)` : text;
}

/**
 * A page that is mostly script and almost no text builds its content in the browser (shops, web apps): fetching
 * it only ever returns the frame. Normal pages are about 10% text; such shells are under 1%.
 */
export function looksScriptRendered(html: string): boolean {
  if (html.length < 400) return false;
  const scripts = blockSpans(html, "script").reduce((total, [start, end]) => total + end - start, 0);
  const text = stripTags(withoutBlocks(html)).replace(/\s+/g, " ");
  return scripts / html.length > 0.4 && text.length / html.length < 0.03;
}

/** Told to a model that fetched an address that doesn't exist (usually a guessed one). */
export const NOT_FOUND_NOTE =
  "(Note: this address doesn't exist on the site, HTTP 404. Don't guess addresses: find the page with web_search, or open the site's home page and use its search or menus.)";

const SCRIPT_RENDERED_NOTE =
  "\n\n(Note: this page builds its content with JavaScript in a browser, so the text above is only the page frame: menus and footer, no listings or results. Other addresses on this site will come back the same way, so don't keep trying URL variants with fetch_url. Open the site with browser_open instead (a real browser) and use its own search box; if you have no browser tools, say that this site needs a real browser.)";

/** "fetch failed" tells a model nothing; say what went wrong so it can fix the address or move on. */
export function explainFetchError(url: string, error: unknown): string {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? (error as { name?: string }).name ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return `${host} doesn't exist (no such domain). Check the address.`;
  if (code === "ECONNREFUSED") return `${host} refused the connection.`;
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return `${host} closed the connection.`;
  if (code === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT")
    return `${host} didn't answer within 15 seconds.`;
  if (/CERT|SSL|TLS/i.test(code)) return `${host} has a certificate problem (${code}).`;
  return `Couldn't reach ${host}: ${cause?.message ?? (error as Error).message}`;
}

/**
 * Fetches a page as readable text. Unless `allowPrivate` (the user approved a local address), no step may reach
 * this machine or the local network: not the address itself once looked up, and not any redirect.
 */
export async function fetchReadable(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  { allowPrivate = false }: { allowPrivate?: boolean } = {},
): Promise<string> {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  let res: Response | undefined;
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const target = new URL(current);
    if (!/^https?:$/.test(target.protocol))
      return `Refused a redirect to ${current}: only http(s) is fetched.`;
    if (!allowPrivate && (await resolvesPrivately(target.hostname))) {
      return `Refused: ${target.host} is on this computer or the local network. Ask the user before fetching local addresses.`;
    }
    try {
      res = await fetchImpl(current, {
        signal: timeout,
        headers: {
          "user-agent": "FreeBird/0.1 (+local assistant)",
          accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5",
        },
        redirect: "manual",
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(explainFetchError(current, error), { cause: error });
    }
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) break;
    current = new URL(location, current).href;
    if (hop === 5) return `Too many redirects (last one to ${current}).`;
  }
  res = res!;
  const type = res.headers.get("content-type") ?? "";
  if (!/text|json|xml|javascript/.test(type))
    return `HTTP ${res.status}. Content type ${type || "unknown"} is not text.`;
  const body = await readCapped(res);
  const text = type.includes("html") ? htmlToText(body) : body;
  const clipped =
    text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…(cut at ${MAX_CHARS} characters)` : text;
  const note =
    res.status === 404 || res.status === 410
      ? `\n\n${NOT_FOUND_NOTE}`
      : type.includes("html") && looksScriptRendered(body)
        ? SCRIPT_RENDERED_NOTE
        : "";
  return `HTTP ${res.status} ${res.url}\n\n${clipped}${note}`;
}
