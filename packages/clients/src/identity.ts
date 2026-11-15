import { canonicalUrl, words } from "@mrog/jobs";

import { hostIn } from "./facts";

/**
 * Telling one company from another: by its own web address, else by its name. Job systems, social sites, registers
 * and directories host many companies, so their addresses never stand for one.
 */

const SHARED_HOSTS =
  /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|myworkdayjobs\.com|smartrecruiters\.com|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|pinterest\.[a-z.]+|google\.[a-z.]+|bing\.com|duckduckgo\.com|wikipedia\.org|reddit\.com|quora\.com|medium\.com|substack\.com|github\.com|gov\.uk|nhs\.uk|yell\.com|trustpilot\.com|glassdoor\.[a-z.]+|indeed\.[a-z.]+|crunchbase\.com|bloomberg\.com|endole\.co\.uk|opencorporates\.com|companycheck\.co\.uk|bbc\.co\.uk|wix\.com|wixsite\.com|squarespace\.com|wordpress\.com|blogspot\.com|eventbrite\.[a-z.]+|amazon\.[a-z.]+|apple\.com|upwork\.com|fiverr\.com|clutch\.co|freeindex\.co\.uk|checkatrade\.com|bark\.com|thomsonlocal\.com|192\.com|uk\.businessesforsale\.com)$/;

/** The company's own domain from an address or a written web address, or null for a host many companies share. */
export function companyDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const host = hostIn(raw);
  return host && !SHARED_HOSTS.test(host) ? host : null;
}

/** Words that don't tell two companies apart. */
const GENERIC = new Set([
  "limited",
  "llp",
  "holdings",
  "group",
  "uk",
  "the",
  "company",
  "services",
  "solutions",
  "and",
]);

/** A company's name reduced to the words that tell it apart ("The Brightside Kitchens Ltd" → "brightside kitchens"). */
export function nameKey(name: string | null | undefined): string {
  return words(name ?? "")
    .filter((w) => !GENERIC.has(w))
    .join(" ");
}

/** The fingerprints of a company: by domain and by name. */
export function companyPrints(company: { domain: string | null; name: string | null }): string[] {
  const prints: string[] = [];
  if (company.domain) prints.push(`d:${company.domain}`);
  const key = nameKey(company.name);
  if (key) prints.push(`n:${key}`);
  return prints;
}

const SUFFIX = /\.(co|org|ltd|plc|me|net|ac|sch)\.uk$|\.[a-z]{2,}$/;

/**
 * Whether a web address may be the company's own site, by its name: "brightsidekitchens.co.uk" for "Brightside
 * Kitchens Ltd". Used to pick the company's site from search results; the site is then read and checked.
 */
export function siteFitsName(raw: string, name: string): boolean {
  const host = companyDomain(raw);
  if (!host) return false;
  const label = host.replace(SUFFIX, "").split(".").pop()!.replace(/-/g, "");
  const parts = nameKey(name).split(" ").filter(Boolean);
  if (parts.length === 0 || label.length < 3) return false;
  const compact = parts.join("");
  if (label.includes(compact) || (label.length >= 5 && compact.includes(label))) return true;
  const first = parts[0]!;
  return first.length >= 5 && label.includes(first);
}

/**
 * A company's name as its own site writes it, found by code: the first run of one to five words on the page whose
 * letters spell the site's address ("madfrans.com" → "Mad Frans", "thecutandcraft.co.uk" → "The Cut & Craft").
 * Null when no phrase on the page matches.
 */
export function nameOnSite(page: { url: string; text: string }): string | null {
  const host = companyDomain(page.url);
  if (!host) return null;
  const label = host.replace(SUFFIX, "").split(".").pop()!.replace(/-/g, "");
  if (label.length < 3) return null;
  const tokens = page.text
    .slice(0, 5000)
    .split(/[\s|]+/)
    .filter(Boolean);
  const squash = (t: string) =>
    t
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^\p{L}\p{N}]/gu, "");
  for (let i = 0; i < tokens.length; i++) {
    let joined = "";
    for (let n = 0; n < 5 && i + n < tokens.length; n++) {
      joined += squash(tokens[i + n]!);
      if (joined === label) {
        const phrase = tokens
          .slice(i, i + n + 1)
          .join(" ")
          .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
        return phrase || null;
      }
      if (!label.startsWith(joined)) break;
    }
  }
  return null;
}

/** The company's home page for a domain. */
export const homeOf = (domain: string) => `https://${domain}/`;

/** The address tidied, for remembering pages already read. */
export const pageKey = (url: string) => canonicalUrl(url) ?? url;
