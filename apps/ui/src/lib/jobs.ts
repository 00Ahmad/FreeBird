import {
  DEFAULT_JOB_TARGET,
  JOB_COLUMNS,
  MAX_JOB_TARGET,
  type JobCard,
  type JobColumn,
  type JobFactName,
  type JobProfile,
  type JobProject,
  type JobStatus,
  type UpdateJobProfileInput,
} from "@mrog/shared";

/** Plain helpers for the Job Bot's screen; components only render what these work out. */

export const COLUMN_LABELS: Record<JobColumn, string> = {
  found: "Found",
  shortlisted: "Shortlisted",
  preparing: "Preparing",
  applied: "Applied",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  not_for_me: "Not for me",
};

export type BoardSort = "best" | "newest";

export interface BoardView {
  sort?: BoardSort;
  /** Only the jobs the latest scan found. */
  onlyNew?: boolean;
  latestScan?: number | null;
}

const SORTS: Record<BoardSort, (a: JobCard, b: JobCard) => number> = {
  best: (a, b) => b.score - a.score,
  newest: (a, b) => b.foundAt.localeCompare(a.foundAt) || b.score - a.score,
};

/** The board's columns in order, each with its cards, best match first (or newest first). */
export function boardColumns(
  cards: readonly JobCard[],
  view: BoardView = {},
): { column: JobColumn; cards: JobCard[] }[] {
  const shown = view.onlyNew ? cards.filter((card) => card.scan === view.latestScan) : cards;
  return JOB_COLUMNS.map((column) => ({
    column,
    cards: shown.filter((card) => card.column === column).toSorted(SORTS[view.sort ?? "best"]),
  }));
}

/** Found by the latest scan. */
export const isNew = (card: JobCard, project: JobProject) =>
  !!project.scan && card.scan === project.scan.number;

/** "14 Nov": the day a job was found. */
export const foundOn = (card: JobCard) =>
  new Date(card.foundAt).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** What a card says when requirements were added to your profile after the job was read. */
export function uncheckedLine(card: JobCard): string | null {
  if (card.unchecked <= 0) return null;
  const many = card.unchecked > 1;
  return `${card.unchecked} newer requirement${many ? "s" : ""} ${many ? "weren't" : "wasn't"} checked on this job: it was read before you added ${many ? "them" : "it"}.`;
}

export const fact = (card: JobCard, name: JobFactName) =>
  card.facts.find((f) => f.name === name)?.value ?? null;

/** "Senior Backend Engineer · Northwind Robotics". */
export const cardTitle = (card: JobCard) => fact(card, "title") ?? "Untitled job";
export const cardCompany = (card: JobCard) => fact(card, "company") ?? card.site;

export function scoreTone(score: number): "strong" | "good" | "weak" {
  return score >= 75 ? "strong" : score >= 50 ? "good" : "weak";
}

const STATUS_LINES: Record<JobStatus, string> = {
  interview: "Tell me about the job you want",
  awaiting_profile: "Your profile is ready: approve it to start searching",
  ready: "Ready to scan",
  scanning: "Scanning",
  waiting_for_you: "Waiting for you",
  error: "The last scan failed",
};

/** One line about what the bot is doing, shown above the board. */
export function statusLine(project: JobProject): string {
  const scan = project.scan;
  // Busy but not scanning: checking whether the board's jobs are still open.
  if (project.status === "scanning" && project.note) return project.note;
  if (project.status === "scanning" && scan)
    return `Scan ${scan.number}: ${scan.found} of ${scan.target} new jobs (${scan.pagesRead} pages read)`;
  if (project.status === "waiting_for_you" && project.handoff) return project.handoff.reason;
  if (project.status === "ready" && scan?.stopReason) return `Last scan: ${scan.stopReason}`;
  return project.note ?? STATUS_LINES[project.status];
}

export const canScan = (project: JobProject) => project.status === "ready" || project.status === "error";
export const isScanning = (project: JobProject) =>
  project.status === "scanning" || project.status === "waiting_for_you";

/** What the composer says in a Job Bot's chat. */
export function jobComposer(
  project: JobProject | undefined,
  name: string,
): { placeholder: string; hint: string } {
  if (!project) return { placeholder: `Message ${name}`, hint: "" };
  if (isScanning(project)) return { placeholder: `Say "stop" to end the scan`, hint: statusLine(project) };
  if (project.status === "ready" || project.status === "error")
    return { placeholder: `Ask ${name} to search, or tell it what to change in your profile`, hint: "" };
  return { placeholder: `Tell ${name} about the job you want`, hint: "" };
}

/** The number a scan asks for, from what was typed: a whole number from 1 to 50, or the problem with it. */
export function scanTarget(raw: string): { target: number } | { problem: string } {
  const n = Number(raw.trim());
  if (!raw.trim() || !Number.isInteger(n)) return { problem: "Type a whole number." };
  if (n < 1 || n > MAX_JOB_TARGET) return { problem: `Pick a number from 1 to ${MAX_JOB_TARGET}.` };
  return { target: n };
}

export const suggestedTarget = (project: JobProject | undefined) => project?.lastTarget ?? DEFAULT_JOB_TARGET;

/** The profile's list fields, as the profile card edits them (one item per line). */
export const LIST_FIELDS = [
  ["titles", "Job titles"],
  ["relatedTitles", "Also goes by"],
  ["places", "Places"],
  ["mustHaves", "Must have"],
  ["niceToHaves", "Nice to have"],
  ["dealBreakers", "Deal-breakers"],
  ["avoidIndustries", "Industries to avoid"],
  ["avoidCompanies", "Companies to avoid"],
  ["languages", "Languages"],
] as const satisfies readonly (readonly [keyof JobProfile, string])[];

export type ListField = (typeof LIST_FIELDS)[number][0];

export const linesOf = (list: readonly string[]) => list.join("\n");

/** One item per line, blank lines dropped. */
export const listFrom = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** The change between the saved profile and what the card shows, or null when nothing changed. */
export function profileChange(saved: JobProfile, edited: JobProfile): UpdateJobProfileInput | null {
  const change: Record<string, unknown> = {};
  for (const key of Object.keys(edited) as (keyof JobProfile)[])
    if (JSON.stringify(saved[key]) !== JSON.stringify(edited[key])) change[key] = edited[key];
  return Object.keys(change).length > 0 ? (change as UpdateJobProfileInput) : null;
}
