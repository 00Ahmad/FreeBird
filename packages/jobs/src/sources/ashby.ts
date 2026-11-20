import { stripHtml } from "../text";
import type { JobSource, SourcePage } from "./types";

/**
 * Ashby's public Job Postings API: no key needed for reading. Checked against a live answer (2026-11-20).
 *   board:   GET https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true
 * There is no endpoint for one posting: its page is found in the board's answer by its id.
 * Web addresses: jobs.ashbyhq.com/{board}[/{posting id}].
 */
const API = "https://api.ashbyhq.com/posting-api/job-board";
const SLUG = /^[a-z0-9][a-z0-9_.-]{0,80}$/i;
const ID = /^[0-9a-f-]{20,40}$/i;

function parts(raw: string): { board: string; id?: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "jobs.ashbyhq.com") return null;
  const [board, id] = url.pathname.split("/").filter(Boolean);
  if (!board || !SLUG.test(board) || (id !== undefined && !ID.test(id))) return null;
  return { board, ...(id ? { id } : {}) };
}

interface AshbyJob {
  id?: string;
  title?: string;
  location?: string;
  isRemote?: boolean;
  isListed?: boolean;
  workplaceType?: string;
  employmentType?: string;
  publishedAt?: string;
  jobUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  compensation?: {
    scrapeableCompensationSalarySummary?: string | null;
    compensationTierSummary?: string | null;
  };
}

const EMPLOYMENT: Record<string, string> = {
  FullTime: "Full-time",
  PartTime: "Part-time",
  Contract: "Contract",
  Intern: "Internship",
  Temporary: "Temporary",
};

function postingPage(job: AshbyJob, board: string): SourcePage | null {
  if (!job.title) return null;
  const lines = [job.title, `Company: ${board}`];
  if (job.location) lines.push(`Location: ${job.location}`);
  if (job.workplaceType) lines.push(`Workplace: ${job.workplaceType}`);
  if (job.employmentType) lines.push(`Employment: ${EMPLOYMENT[job.employmentType] ?? job.employmentType}`);
  const pay =
    job.compensation?.scrapeableCompensationSalarySummary ?? job.compensation?.compensationTierSummary;
  if (pay) lines.push(`Salary: ${pay}`);
  if (job.publishedAt) lines.push(`Posted: ${job.publishedAt.slice(0, 10)}`);
  const description = job.descriptionPlain ?? (job.descriptionHtml ? stripHtml(job.descriptionHtml) : "");
  if (description) lines.push("", description);
  return { title: job.title, text: lines.join("\n"), links: [] };
}

export const ashby: JobSource = {
  id: "ashby",
  label: "Ashby",
  apiUrl(url) {
    const found = parts(url);
    return found ? `${API}/${encodeURIComponent(found.board)}?includeCompensation=true` : null;
  },
  toPage(json, url) {
    const found = parts(url);
    const jobs = (json as { jobs?: AshbyJob[] } | null)?.jobs;
    if (!found || !Array.isArray(jobs)) return null;
    if (found.id) {
      const job = jobs.find((one) => one.id?.toLowerCase() === found.id!.toLowerCase());
      return job ? postingPage(job, found.board) : null;
    }
    const listed = jobs.filter((job) => job.title && job.jobUrl && job.isListed !== false);
    return {
      title: `Jobs at ${found.board}`,
      text: listed.map((job) => `${job.title} - ${job.location ?? ""} (${job.jobUrl})`).join("\n"),
      links: listed.map((job) => ({
        text: job.title!,
        url: job.jobUrl!,
        ...(job.location ? { place: `${job.location}${job.isRemote ? " (Remote)" : ""}` } : {}),
      })),
    };
  },
};
