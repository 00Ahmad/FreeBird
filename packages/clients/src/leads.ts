import { canonicalUrl, fold, siteOf, words } from "@mrog/jobs";

/**
 * Which search results are worth a Checker turn. A turn on a small local model takes tens of seconds, so results that
 * can't be a lead are dropped before any model sees them: social sites and marketplaces the bot doesn't read, and
 * "best payroll companies" lists, which list your competitors.
 */

/** Sites whose terms don't allow automated reading, or that hold no companies to find. */
const NOT_READ =
  /(^|\.)(linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|youtube\.com|pinterest\.[a-z.]+|upwork\.com|fiverr\.com|freelancer\.[a-z.]+|peopleperhour\.com|clutch\.co|goodfirms\.co|g2\.com|capterra\.[a-z.]+|trustpilot\.com|expertmarket\.co\.uk|bark\.com|glassdoor\.[a-z.]+|indeed\.[a-z.]+|wikipedia\.org|amazon\.[a-z.]+|ebay\.[a-z.]+)$/;
const JOB_SYSTEMS = /(^|\.)(greenhouse\.io|lever\.co)$/;
const LIST_PATH = /\b(best|top|leading|cheapest|compare|comparison|reviews?|vs|alternatives?)\b|\btop-?\d+/;
/** "payroll services", "marketing agencies": a page about the providers of a service, not a client. */
const PROVIDERS =
  /^(services?|companies|company|providers?|agencies|agency|firms?|software|bureaus?|solutions|outsourcing)$/;
/** Affiliate and tracking redirects ("/go/EH", "/out/", "/recommends/"): they lead to a provider's sales page. */
const REDIRECT = /^\/(go|out|recommends|visit|redirect|link|click|aff|affiliate)\//i;

/** Whether an address is a list of providers of your service ("/best-payroll-companies-uk"). */
export function isProviderList(url: string, serviceNames: readonly string[]): boolean {
  let path: string;
  try {
    path = fold(decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, " "));
  } catch {
    return false;
  }
  const list = words(path);
  const have = new Set(list.map((w) => w.replace(/s$/, "")));
  return serviceNames.some((name) => {
    const first = words(name)[0]?.replace(/s$/, "");
    if (!first) return false;
    if (LIST_PATH.test(path) && have.has(first)) return true;
    // "/payroll-services/uk": the service's word followed by a word for its providers.
    return list.some((w, i) => w.replace(/s$/, "") === first && PROVIDERS.test(list[i + 1] ?? ""));
  });
}

/** Whether a page's own words say it lists providers of your service ("The 7 best payroll providers in 2026"). */
export function isProviderPage(title: string, text: string, serviceNames: readonly string[]): boolean {
  const head = fold(`${title}\n${text.slice(0, 600)}`);
  return serviceNames.some((name) => {
    const first = words(name)[0];
    if (!first) return false;
    const re = new RegExp(
      `\\b(best|top|leading|\\d+|compare|cheapest|reviewed)\\b[^.\\n]{0,60}\\b${first}s?\\b[^.\\n]{0,30}\\b(services?|companies|providers?|agencies|firms|software|bureaus?)\\b`,
    );
    return re.test(head);
  });
}

export function mayRead(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      /^https?:$/.test(parsed.protocol) && !NOT_READ.test(siteOf(url)) && !REDIRECT.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * The addresses worth reading, best first: job ads on companies' job systems (a hiring sign), then the rest. Repeats,
 * pages already read, sites not read and lists of providers are dropped.
 */
export function pickPages(
  urls: string[],
  skip: ReadonlySet<string>,
  serviceNames: readonly string[],
): string[] {
  const kept = new Map<string, string>();
  for (const url of urls) {
    const key = canonicalUrl(url);
    if (!key || skip.has(key) || kept.has(key) || !mayRead(url) || isProviderList(url, serviceNames))
      continue;
    kept.set(key, url);
  }
  return [...kept.values()]
    .map((url, index) => ({ url, index, rank: JOB_SYSTEMS.test(siteOf(url)) ? 0 : 1 }))
    .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.url);
}
