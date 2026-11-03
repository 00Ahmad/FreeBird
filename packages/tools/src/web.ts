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
 * Readable text from an HTML page: drops scripts, styles and tags, keeps link targets, and shows forms and their
 * fields (a site's search box is how a person finds things there).
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<form\b([^>]*)>/gi, (_whole, attrs: string) => {
      const method = (attr(attrs, "method") ?? "get").toUpperCase();
      return `\n[form: ${method} ${attr(attrs, "action") || "(this page)"}]\n`;
    })
    .replace(/<(input|textarea|select)\b([^>]*)>/gi, (_whole, tag: string, attrs: string) => {
      const type = (attr(attrs, "type") ?? (tag.toLowerCase() === "input" ? "text" : tag)).toLowerCase();
      if (/^(hidden|submit|button|image|reset)$/.test(type)) return " ";
      const label = attr(attrs, "aria-label") ?? attr(attrs, "placeholder");
      const name = attr(attrs, "name");
      return ` [${type} field${label ? ` "${label}"` : ""}${name ? ` name=${name}` : ""}] `;
    })
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * A page that is mostly script and almost no text builds its content in the browser (shops, web apps): fetching
 * it only ever returns the frame. Normal pages are about 10% text; such shells are under 1%.
 */
export function looksScriptRendered(html: string): boolean {
  if (html.length < 400) return false;
  const scripts = [...html.matchAll(/<script[^>]*>[\s\S]*?<\/script>/gi)].reduce(
    (total, match) => total + match[0].length,
    0,
  );
  const text = html
    .replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
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
