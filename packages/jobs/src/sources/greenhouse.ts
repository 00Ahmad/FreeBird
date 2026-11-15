import { stripHtml } from "../text";
import type { JobSource, SourcePage } from "./types";

/**
 * Greenhouse's Job Board API: public, no key needed for reading (docs.greenhouse.io/job-board.html).
 *   board:   GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs
 *   posting: GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}
 * Web addresses: boards.greenhouse.io/{board}[/jobs/{id}], job-boards.greenhouse.io/{board}[/jobs/{id}], and the
 * embed form boards.greenhouse.io/embed/job_app?for={board}&token={id}.
 */
const API = "https://boards-api.greenhouse.io/v1/boards";
const SLUG = /^[a-z0-9][a-z0-9_-]{0,80}$/i;

function parts(raw: string): { board: string; id?: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^(boards|job-boards)\.greenhouse\.io$/i.test(url.hostname)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "embed") {
    const board = url.searchParams.get("for") ?? "";
    const id = url.searchParams.get("token") ?? undefined;
    return SLUG.test(board) && (!id || /^\d+$/.test(id)) ? { board, id } : null;
  }
  const [board, kind, id] = segments;
  if (!board || !SLUG.test(board)) return null;
  if (kind === undefined) return { board };
  return kind === "jobs" && id && /^\d+$/.test(id) ? { board, id } : null;
}

interface GreenhouseJob {
  id?: number;
  title?: string;
  company_name?: string;
  absolute_url?: string;
  location?: { name?: string };
  first_published?: string;
  updated_at?: string;
  content?: string;
}

function postingPage(job: GreenhouseJob): SourcePage | null {
  if (!job.title) return null;
  const lines = [job.title];
  if (job.company_name) lines.push(`Company: ${job.company_name}`);
  if (job.location?.name) lines.push(`Location: ${job.location.name}`);
  if (job.first_published) lines.push(`Posted: ${job.first_published.slice(0, 10)}`);
  if (job.content) lines.push("", stripHtml(job.content));
  return { title: job.title, text: lines.join("\n"), links: [] };
}

export const greenhouse: JobSource = {
  id: "greenhouse",
  label: "Greenhouse",
  apiUrl(url) {
    const found = parts(url);
    if (!found) return null;
    return found.id ? `${API}/${found.board}/jobs/${found.id}` : `${API}/${found.board}/jobs`;
  },
  toPage(json, url) {
    const found = parts(url);
    if (!found || typeof json !== "object" || json === null) return null;
    if (found.id) return postingPage(json as GreenhouseJob);
    const jobs = (json as { jobs?: GreenhouseJob[] }).jobs;
    if (!Array.isArray(jobs)) return null;
    const listed = jobs.filter((job) => job.title && job.absolute_url);
    return {
      title: `Jobs at ${found.board}`,
      text: listed
        .map((job) => `${job.title} - ${job.location?.name ?? ""} (${job.absolute_url})`)
        .join("\n"),
      links: listed.map((job) => ({ text: job.title!, url: job.absolute_url! })),
    };
  },
};
