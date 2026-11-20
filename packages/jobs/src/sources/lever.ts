import { stripHtml } from "../text";
import type { JobSource, SourcePage } from "./types";

/**
 * Lever's Postings API: public, no key needed for reading (github.com/lever/postings-api).
 *   board:   GET https://api.lever.co/v0/postings/{site}?mode=json
 *   posting: GET https://api.lever.co/v0/postings/{site}/{id}
 * Web addresses: jobs.lever.co/{site}[/{id}]; EU sites are jobs.eu.lever.co with api.eu.lever.co.
 */
const SLUG = /^[a-z0-9][a-z0-9_.-]{0,80}$/i;
const ID = /^[0-9a-f-]{20,40}$/i;

function parts(raw: string): { api: string; site: string; id?: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = /^jobs\.(eu\.)?lever\.co$/i.exec(url.hostname);
  if (!host) return null;
  const [site, id] = url.pathname.split("/").filter(Boolean);
  if (!site || !SLUG.test(site) || (id !== undefined && !ID.test(id))) return null;
  return { api: host[1] ? "https://api.eu.lever.co" : "https://api.lever.co", site, id };
}

interface LeverPosting {
  id?: string;
  text?: string;
  hostedUrl?: string;
  categories?: { location?: string; commitment?: string; team?: string };
  workplaceType?: string;
  salaryRange?: { currency?: string; interval?: string; min?: number; max?: number };
  salaryDescriptionPlain?: string;
  descriptionPlain?: string;
  lists?: { text?: string; content?: string }[];
  additionalPlain?: string;
  /** When the posting was made, in milliseconds (checked against a live answer, 2026-11-20). */
  createdAt?: number;
}

const WORKPLACE: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", "on-site": "On-site" };

function postingPage(posting: LeverPosting, site: string): SourcePage | null {
  if (!posting.text) return null;
  const lines = [posting.text, `Company: ${site}`];
  const where = posting.categories?.location;
  if (where) lines.push(`Location: ${where}`);
  const workplace = WORKPLACE[posting.workplaceType ?? ""];
  if (workplace) lines.push(`Workplace: ${workplace}`);
  if (posting.categories?.commitment) lines.push(`Employment: ${posting.categories.commitment}`);
  // The posting date, so an old posting gets its warning (Lever's own pages don't show one).
  if (typeof posting.createdAt === "number" && Number.isFinite(posting.createdAt))
    lines.push(`Posted: ${new Date(posting.createdAt).toISOString().slice(0, 10)}`);
  const salary = posting.salaryRange;
  if (salary?.min !== undefined && salary.max !== undefined)
    lines.push(
      `Salary: ${salary.min} - ${salary.max} ${salary.currency ?? ""} ${salary.interval ?? ""}`.trim(),
    );
  if (posting.salaryDescriptionPlain) lines.push(posting.salaryDescriptionPlain);
  if (posting.descriptionPlain) lines.push("", posting.descriptionPlain);
  for (const list of posting.lists ?? [])
    if (list.text) lines.push("", list.text, stripHtml(list.content ?? ""));
  if (posting.additionalPlain) lines.push("", posting.additionalPlain);
  return { title: posting.text, text: lines.join("\n"), links: [] };
}

export const lever: JobSource = {
  id: "lever",
  label: "Lever",
  apiUrl(url) {
    const found = parts(url);
    if (!found) return null;
    return found.id
      ? `${found.api}/v0/postings/${found.site}/${found.id}`
      : `${found.api}/v0/postings/${found.site}?mode=json`;
  },
  toPage(json, url) {
    const found = parts(url);
    if (!found || typeof json !== "object" || json === null) return null;
    if (found.id) return postingPage(json as LeverPosting, found.site);
    if (!Array.isArray(json)) return null;
    const listed = (json as LeverPosting[]).filter((posting) => posting.text && posting.hostedUrl);
    return {
      title: `Jobs at ${found.site}`,
      text: listed
        .map((posting) => `${posting.text} - ${posting.categories?.location ?? ""} (${posting.hostedUrl})`)
        .join("\n"),
      links: listed.map((posting) => ({
        text: posting.text!,
        url: posting.hostedUrl!,
        ...(posting.categories?.location ? { place: posting.categories.location } : {}),
      })),
    };
  },
};
