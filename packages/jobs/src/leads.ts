import { canonicalUrl, siteOf } from "./dedupe";

/**
 * Which search results are worth a Checker turn. A turn on a small local model takes tens of seconds, so results that
 * can't be a job (a blog post, a salary guide, a video) are dropped before any model sees them.
 */

/** Companies' own career sites: the best source, read first. */
const CAREER_SITES =
  /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|workable\.com|recruitee\.com|bamboohr\.com|jobvite\.com|icims\.com|teamtailor\.com|personio\.(de|com)|breezy\.hr|jazzhr\.com|rippling-ats\.com|pinpointhq\.com|join\.com)$/;

/** Job sites: read a posting you were sent to, never crawl. */
const JOB_SITES =
  /(^|\.)(linkedin\.com|indeed\.[a-z.]+|glassdoor\.[a-z.]+|ziprecruiter\.com|monster\.[a-z.]+|reed\.co\.uk|totaljobs\.com|stepstone\.[a-z.]+|seek\.com\.au|simplyhired\.com|dice\.com|wellfound\.com|otta\.com|welcometothejungle\.com|remoteok\.com|weworkremotely\.com|builtin\.com|jobs\.ch|xing\.com|naukri\.com|rozee\.pk|bayt\.com)$/;

/** Sites that don't allow automated reading of their listings: a single posting may be read, its links never followed. */
const NO_FOLLOW = /(^|\.)(linkedin\.com|indeed\.[a-z.]+|glassdoor\.[a-z.]+)$/;

const JOB_PATH =
  /job|career|position|vacanc|opening|posting|apply|recruit|hiring|stellen|empleo|emploi|lavoro|vagas|werken/i;
const NOT_A_JOB =
  /(^|\.)(youtube\.com|reddit\.com|quora\.com|facebook\.com|twitter\.com|x\.com|instagram\.com|tiktok\.com|wikipedia\.org|medium\.com)$|\/(blog|news|article|articles|wiki|salary|salaries|salary-guide|interview-questions|resume|cv-template)(\/|$)/i;

export type LeadKind = "career_site" | "job_site" | "other";

export function leadKind(url: string): LeadKind {
  const host = siteOf(url);
  if (CAREER_SITES.test(host)) return "career_site";
  if (JOB_SITES.test(host)) return "job_site";
  return "other";
}

/** Whether an address may be a job posting or a list of jobs. */
export function looksLikeJob(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (NOT_A_JOB.test(host) || NOT_A_JOB.test(parsed.pathname)) return false;
  if (leadKind(url) !== "other") return true;
  // A company's own site: a careers or jobs page, or a jobs subdomain.
  return JOB_PATH.test(parsed.pathname) || /^(jobs|careers|career|work|join)\./.test(host);
}

/** Whether links on this page may be followed (not on the job sites that forbid automated reading). */
export const mayFollowLinks = (url: string) => !NO_FOLLOW.test(siteOf(url));

const RANK: Record<LeadKind, number> = { career_site: 0, other: 1, job_site: 2 };

/**
 * The addresses worth reading, best first: companies' career sites, then other company pages, then job sites. Repeats
 * and addresses already read or seen are dropped.
 */
export function pickLeads(urls: string[], skip: ReadonlySet<string>): string[] {
  const kept = new Map<string, string>();
  for (const url of urls) {
    const key = canonicalUrl(url);
    if (!key || skip.has(`u:${key}`) || kept.has(key) || !looksLikeJob(url)) continue;
    kept.set(key, url);
  }
  return [...kept.values()]
    .map((url, index) => ({ url, index }))
    .toSorted((a, b) => RANK[leadKind(a.url)] - RANK[leadKind(b.url)] || a.index - b.index)
    .map((item) => item.url);
}
