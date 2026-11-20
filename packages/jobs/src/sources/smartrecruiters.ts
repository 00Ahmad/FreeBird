import { stripHtml } from "../text";
import type { JobSource, SourcePage } from "./types";

/**
 * SmartRecruiters' public Posting API: no key needed for reading. Checked against live answers (2026-11-20).
 *   board:   GET https://api.smartrecruiters.com/v1/companies/{company}/postings?limit=100
 *   posting: GET https://api.smartrecruiters.com/v1/companies/{company}/postings/{id}
 * Web addresses: jobs.smartrecruiters.com/{company}[/{id}--{slug}], careers.smartrecruiters.com/{company}.
 */
const API = "https://api.smartrecruiters.com/v1/companies";
const COMPANY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

function parts(raw: string): { company: string; id?: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^(jobs|careers)\.smartrecruiters\.com$/i.test(url.hostname)) return null;
  const [company, posting] = url.pathname.split("/").filter(Boolean);
  if (!company || !COMPANY.test(company)) return null;
  if (posting === undefined) return { company };
  const id = /^(\d{6,})/.exec(posting)?.[1];
  return id ? { company, id } : null;
}

interface SrPosting {
  id?: string;
  name?: string;
  company?: { name?: string };
  location?: { fullLocation?: string; remote?: boolean; hybrid?: boolean };
  typeOfEmployment?: { label?: string };
  releasedDate?: string;
  compensation?: { min?: number; max?: number; currency?: string; period?: string };
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
}

const PERIOD: Record<string, string> = { YEARLY: "per year", MONTHLY: "per month", HOURLY: "per hour" };

function postingPage(posting: SrPosting): SourcePage | null {
  if (!posting.name) return null;
  const lines = [posting.name];
  if (posting.company?.name) lines.push(`Company: ${posting.company.name}`);
  if (posting.location?.fullLocation) lines.push(`Location: ${posting.location.fullLocation}`);
  if (posting.location?.remote) lines.push("Workplace: Remote");
  else if (posting.location?.hybrid) lines.push("Workplace: Hybrid");
  if (posting.typeOfEmployment?.label) lines.push(`Employment: ${posting.typeOfEmployment.label}`);
  const pay = posting.compensation;
  if (pay?.min !== undefined && pay.max !== undefined)
    lines.push(
      `Salary: ${pay.min} - ${pay.max} ${pay.currency ?? ""} ${PERIOD[pay.period ?? ""] ?? ""}`.trim(),
    );
  if (posting.releasedDate) lines.push(`Posted: ${posting.releasedDate.slice(0, 10)}`);
  for (const section of Object.values(posting.jobAd?.sections ?? {}))
    if (section.text) lines.push("", ...(section.title ? [section.title] : []), stripHtml(section.text));
  return { title: posting.name, text: lines.join("\n"), links: [] };
}

export const smartRecruiters: JobSource = {
  id: "smartrecruiters",
  label: "SmartRecruiters",
  apiUrl(url) {
    const found = parts(url);
    if (!found) return null;
    const company = encodeURIComponent(found.company);
    return found.id ? `${API}/${company}/postings/${found.id}` : `${API}/${company}/postings?limit=100`;
  },
  toPage(json, url) {
    const found = parts(url);
    if (!found || typeof json !== "object" || json === null) return null;
    if (found.id) return postingPage(json as SrPosting);
    const content = (json as { content?: SrPosting[] }).content;
    if (!Array.isArray(content)) return null;
    const listed = content.filter((posting) => posting.name && posting.id);
    const link = (posting: SrPosting) => `https://jobs.smartrecruiters.com/${found.company}/${posting.id}`;
    return {
      title: `Jobs at ${found.company}`,
      text: listed
        .map((posting) => `${posting.name} - ${posting.location?.fullLocation ?? ""} (${link(posting)})`)
        .join("\n"),
      links: listed.map((posting) => ({
        text: posting.name!,
        url: link(posting),
        ...(posting.location?.fullLocation ? { place: posting.location.fullLocation } : {}),
      })),
    };
  },
};
