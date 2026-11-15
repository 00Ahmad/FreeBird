import type { PageLink } from "./page";
import { canonicalUrl } from "./dedupe";

/** Links written into page text as "words (address)", the way fetched pages show them; relative ones resolved. */
export function linksFromText(text: string, base: string): PageLink[] {
  const links: PageLink[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/([^\n()]{0,120})\((https?:\/\/[^\s()]+|\/[^\s()]*)\)/g)) {
    let url: string;
    try {
      url = new URL(match[2]!, base).href;
    } catch {
      continue;
    }
    const key = canonicalUrl(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    links.push({ text: match[1]!.replace(/\s+/g, " ").trim(), url });
  }
  return links;
}

/**
 * The addresses a model named that really are links on the page, as the page has them. A model reading a list page
 * names jobs to look at; one it made up, or one on another page, is dropped.
 */
export function linksOnPage(named: string[], links: PageLink[]): string[] {
  const byKey = new Map(links.map((link) => [canonicalUrl(link.url), link.url]));
  const kept: string[] = [];
  for (const raw of named) {
    const found = byKey.get(canonicalUrl(raw));
    if (found && !kept.includes(found)) kept.push(found);
  }
  return kept;
}
