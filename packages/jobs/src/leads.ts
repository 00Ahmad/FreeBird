import { canonicalUrl, siteOf } from "./dedupe";
import { words } from "./text";

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

/** A web search result: its address, and the title the search engine showed for it when it said. */
export interface SearchHit {
  url: string;
  title?: string;
}

/** A single posting's address (an id or a slug after /jobs/, /job/, /careers/, /positions/), not a list. */
const POSTING_PATH =
  /\/(jobs?|careers?|positions?|vacanc(y|ies)|openings?|o)\/[^/?#]*(\d{3,}|[a-z]+-[a-z]+)[^/?#]*\/?$/i;

/** Words of a job title that don't say what the job is. */
const TITLE_NOISE = new Set([
  "senior",
  "junior",
  "lead",
  "staff",
  "principal",
  "head",
  "jobs",
  "job",
  "careers",
  "career",
  "hiring",
  "remote",
  "apply",
]);

const titleWords = (text: string) =>
  words(text)
    .map((word) => (word.length > 3 ? word.replace(/(es|s)$/, "") : word))
    .filter((word) => !TITLE_NOISE.has(word));

/**
 * Search results in the order worth reading, using the titles the search showed: a result whose title has a title you
 * want in it comes first; a single posting whose title shares no word with any title you want is another job, and is
 * dropped before anyone reads it. A result with no title keeps its place.
 */
export function rankHits(hits: readonly (SearchHit | string)[], titles: readonly string[]): string[] {
  const wanted = new Set(titles.flatMap(titleWords));
  const ranked = hits
    .map((hit, index) => (typeof hit === "string" ? { url: hit, index } : { ...hit, index }))
    .flatMap((hit) => {
      const title = "title" in hit ? hit.title : undefined;
      if (!title) return [{ url: hit.url, index: hit.index, rank: 1 }];
      const have = titleWords(title);
      const fits = titles.some((wantedTitle) => {
        const need = titleWords(wantedTitle);
        return need.length > 0 && need.every((word) => have.includes(word));
      });
      if (fits) return [{ url: hit.url, index: hit.index, rank: 0 }];
      if (
        POSTING_PATH.test(new URL(hit.url, "https://x.invalid").pathname) &&
        !have.some((word) => wanted.has(word))
      )
        return [];
      return [{ url: hit.url, index: hit.index, rank: 1 }];
    });
  return ranked.toSorted((a, b) => a.rank - b.rank || a.index - b.index).map((hit) => hit.url);
}
