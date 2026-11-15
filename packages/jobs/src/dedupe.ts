import { fold, words } from "./text";

/**
 * Telling one job from another across scans and sites. A job is "seen" by its posting address (tidied) and by its
 * company, title and place, so the same job found on a job site and on the company's own page counts once.
 */

/** Query parameters that only say where a click came from. */
const TRACKING =
  /^(utm_\w+|gclid|fbclid|msclkid|ref|refid|source|src|trk|trackingid|gh_src|lever-source|from)$/i;

/** The address tidied for comparing: no tracking parameters, no #fragment, no "www.", no trailing slash. */
export function canonicalUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING.test(key))
    .toSorted(([a], [b]) => a.localeCompare(b));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `${host}${path}${query}`;
}

export interface JobIdentity {
  url: string;
  company?: string | null;
  title?: string | null;
  location?: string | null;
}

const key = (text: string | null | undefined) => words(text ?? "").join(" ");

/** The fingerprints of a job: by address, and by company + title + place when the company and title are known. */
export function fingerprints(job: JobIdentity): string[] {
  const prints: string[] = [];
  const url = canonicalUrl(job.url);
  if (url) prints.push(`u:${url}`);
  const company = key(job.company);
  const title = key(job.title);
  if (company && title) prints.push(`j:${company}|${title}|${key(job.location)}`);
  return prints;
}

/** Whether any of the fingerprints was seen before. */
export const isSeen = (seen: ReadonlySet<string>, prints: string[]) =>
  prints.some((print) => seen.has(print));

/** The seen list with the new fingerprints added, keeping the newest `max`. */
export function remember(seen: string[], prints: string[], max: number): string[] {
  const known = new Set(seen);
  const added = prints.filter((print) => !known.has(print));
  return [...seen, ...added].slice(-max);
}

/** The site name of an address, for the card and the site notes ("boards.greenhouse.io"). */
export function siteOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return fold(raw).slice(0, 80);
  }
}

/** Job systems that host many companies on one address, each under its own first path part. */
const SHARED_HOSTS =
  /^(boards|job-boards)(\.eu)?\.greenhouse\.io$|^jobs(\.eu)?\.lever\.co$|^jobs\.ashbyhq\.com$|^apply\.workable\.com$/;

/**
 * One employer's site, for telling which site keeps failing: the host, plus the company's part of the path on a job
 * system that hosts many companies ("job-boards.greenhouse.io/gitlab"), so one company's closed jobs never count
 * against another's.
 */
export function employerSite(raw: string): string {
  const site = siteOf(raw);
  if (!SHARED_HOSTS.test(site)) return site;
  try {
    const first = new URL(raw).pathname.split("/").find(Boolean);
    return first ? `${site}/${first.toLowerCase()}` : site;
  } catch {
    return site;
  }
}
