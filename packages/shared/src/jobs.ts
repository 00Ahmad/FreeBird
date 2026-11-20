import { z } from "zod";

import { BotName } from "./bots";
import { BotId } from "./ids";
import { ModelRef } from "./models";

/**
 * A Job Bot interviews you about the job you want, then searches for jobs that fit you when you start a scan, checks
 * each one against the page it was read from, and keeps them on a board. Types and limits only: the logic is in
 * @mrog/jobs, the wiring in the harness.
 */
export const JOB_ROLES = ["interviewer", "searcher", "checker", "visual"] as const;
export const JobRole = z.enum(JOB_ROLES);
export type JobRole = z.infer<typeof JobRole>;

/** Each scan finds at most this many new jobs; you choose how many each time. */
export const MAX_JOB_TARGET = 50;
export const DEFAULT_JOB_TARGET = 10;
/** Cards on the board; the oldest "Not for me" ones go first when it is full. */
export const MAX_JOB_CARDS = 500;
/** Fingerprints of jobs already shown, so a later scan counts only new ones. */
export const MAX_SEEN_JOBS = 3000;
export const MAX_JOB_LOG = 50;
/** Pages that led nowhere, remembered so later scans don't read them again. */
export const MAX_DEAD_PAGES = 2000;
/** Searches run, remembered so later scans look somewhere new. */
export const MAX_SEARCHES_RUN = 300;
export const MAX_SITE_NOTES = 200;

const Short = (max: number) => z.string().trim().max(max);
const List = (item: number, count: number) => z.array(Short(item).min(1)).max(count);

export const Workplace = z.enum(["remote", "hybrid", "office"]);
export type Workplace = z.infer<typeof Workplace>;

export const SalaryFloor = z.object({
  amount: z.number().min(0).max(100_000_000),
  currency: Short(8).min(1),
  period: z.enum(["year", "month", "hour"]),
});
export type SalaryFloor = z.infer<typeof SalaryFloor>;

/** What you want, from the interview. Every field can be edited on the profile card. */
export const JobProfile = z.object({
  /** The job titles you want. */
  titles: List(80, 10).default([]),
  /** Other titles the same job goes by ("Platform Engineer" for "Backend Engineer"). */
  relatedTitles: List(80, 15).default([]),
  mustHaves: List(200, 20).default([]),
  niceToHaves: List(200, 20).default([]),
  /** A job with one of these is never a match. */
  dealBreakers: List(200, 20).default([]),
  minSalary: SalaryFloor.nullable().default(null),
  workplace: z.array(Workplace).max(3).default([]),
  /** Cities, regions or countries. */
  places: List(100, 10).default([]),
  /** How far you'd travel, in your words. */
  travel: Short(200).default(""),
  /** Right to work, visa or sponsorship, in your words. */
  rightToWork: Short(300).default(""),
  seniority: Short(80).default(""),
  avoidIndustries: List(100, 20).default([]),
  avoidCompanies: List(100, 50).default([]),
  languages: List(60, 10).default([]),
  /** Your skills and experience in your words (no CV file in this version). */
  experience: Short(2000).default(""),
});
export type JobProfile = z.infer<typeof JobProfile>;

export const JOB_FACTS = [
  "title",
  "company",
  "location",
  "workplace",
  "salary",
  "seniority",
  "employment",
  "posted",
] as const;
export const JobFactName = z.enum(JOB_FACTS);
export type JobFactName = z.infer<typeof JobFactName>;

/** One fact about a job: its value and the words on the page it came from. No quote that checks out: "not stated". */
export const JobFact = z.object({
  name: JobFactName,
  /** Null: not stated on the page (or the quote didn't check out). */
  value: z.string().nullable(),
  quote: z.string().nullable(),
});
export type JobFact = z.infer<typeof JobFact>;

export const MatchVerdict = z.enum(["meets", "partly", "misses", "unknown"]);
export type MatchVerdict = z.infer<typeof MatchVerdict>;

/** What a requirement is, which sets its weight in the score. */
export const RequirementKind = z.enum([
  "title",
  "place",
  "workplace",
  "salary",
  "must",
  "nice",
  "dealbreaker",
]);
export type RequirementKind = z.infer<typeof RequirementKind>;

/** How the job does on one of your requirements, and why. For a deal-breaker, "meets" means the job is free of it. */
export const MatchLine = z.object({
  kind: RequirementKind,
  requirement: z.string(),
  verdict: MatchVerdict,
  reason: z.string(),
  /** Decided by the app from facts checked against the page; otherwise the reason is the Checker's own words. */
  byCode: z.boolean().optional(),
});
export type MatchLine = z.infer<typeof MatchLine>;

export const JobWarning = z.object({
  /** Which rule found it ("old-posting", "no-salary"…), or "checker" for the Checker's own. */
  id: z.string(),
  text: z.string(),
});
export type JobWarning = z.infer<typeof JobWarning>;

/** How a page was read: a job system's list, as text, in the bot's browser, by the Visual Bot, or by you. */
export const JobReader = z.enum(["api", "text", "browser", "visual", "you"]);
export type JobReader = z.infer<typeof JobReader>;

export const JobColumn = z.enum([
  "found",
  "shortlisted",
  "preparing",
  "applied",
  "interview",
  "offer",
  "rejected",
  "not_for_me",
]);
export type JobColumn = z.infer<typeof JobColumn>;
export const JOB_COLUMNS = JobColumn.options;

export const JobCard = z.object({
  id: z.string(),
  /** The page the job was read from: always one this bot actually read, never an address a model gave. */
  url: z.string(),
  site: z.string(),
  readBy: JobReader,
  foundAt: z.iso.datetime(),
  /** Which scan found it. */
  scan: z.number().int().min(1),
  column: JobColumn,
  facts: z.array(JobFact),
  /** One short line about the job, from the Checker. */
  summary: z.string(),
  match: z.array(MatchLine),
  /** 0 to 100, worked out by code from the match lines. */
  score: z.number().min(0).max(100),
  warnings: z.array(JobWarning),
  /** What the posting says about the company, each with its quote. */
  company: z.array(z.object({ text: z.string(), quote: z.string() })),
  reaction: z.enum(["up", "down"]).nullable(),
  reason: z.string().nullable(),
  /** Requirements added to your profile since this job was read, which only reading it again could check. */
  unchecked: z.number().int().min(0).default(0),
});
export type JobCard = z.infer<typeof JobCard>;

export const JobScan = z.object({
  number: z.number().int().min(1),
  /** How many new jobs you asked for. */
  target: z.number().int().min(1).max(MAX_JOB_TARGET),
  /** New jobs that match (score 50 or more): what counts toward the target. */
  found: z.number().int().min(0),
  /** New jobs that were checked but match weakly: on the board, not counted. */
  weaker: z.number().int().min(0).default(0),
  pagesRead: z.number().int().min(0),
  visualPages: z.number().int().min(0),
  searchRounds: z.number().int().min(0),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  /** Why it ended, in plain words; null while it runs. */
  stopReason: z.string().nullable(),
});
export type JobScan = z.infer<typeof JobScan>;

/** What worked last time on a website, so the next scan goes straight to it. */
export const SiteNote = z.object({
  host: z.string(),
  reader: JobReader,
  at: z.iso.datetime(),
});
export type SiteNote = z.infer<typeof SiteNote>;

/**
 * A page that led nowhere: not a job, a closed or missing job, a job that couldn't be confirmed, or one already shown
 * under another address. Never a list of jobs: new jobs appear on those.
 */
export const DeadPage = z.object({
  /** The address, tidied (canonicalUrl). */
  key: z.string(),
  reason: z.string(),
  at: z.iso.datetime(),
  /** It won't come back (the page is gone, or the job closed): skipped for longer. */
  lasting: z.boolean(),
});
export type DeadPage = z.infer<typeof DeadPage>;

/** A web search a scan ran. */
export const SearchRun = z.object({ query: z.string(), at: z.iso.datetime() });
export type SearchRun = z.infer<typeof SearchRun>;

/** The profile list fields a reaction can suggest adding to. */
export const SUGGESTIBLE_FIELDS = [
  "dealBreakers",
  "avoidIndustries",
  "avoidCompanies",
  "mustHaves",
  "niceToHaves",
  /** "too junior": the seniority you want, in words. */
  "seniority",
  /** "salary too low": your lowest salary, as "<amount> <currency> <period>". */
  "minSalary",
] as const;

/** A change to your profile suggested by a 👍 or 👎 with a reason. Never applied without you. */
export const ProfileSuggestion = z.object({
  id: z.string(),
  field: z.enum(SUGGESTIBLE_FIELDS),
  value: z.string(),
  because: z.string(),
});
export type ProfileSuggestion = z.infer<typeof ProfileSuggestion>;
export const MAX_SUGGESTIONS = 10;

export const JobStatus = z.enum([
  /** Asking you about the job you want. */
  "interview",
  /** The profile is ready and waiting for your approval. */
  "awaiting_profile",
  /** Waiting for you to start a scan. */
  "ready",
  "scanning",
  /** A page needs you (a CAPTCHA or a sign-in): continue or skip. */
  "waiting_for_you",
  "error",
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobRoleSeat = z.object({ botId: BotId, model: ModelRef.nullable() });
export type JobRoleSeat = z.infer<typeof JobRoleSeat>;

export const JobProject = z.object({
  /** The Job Bot. */
  botId: BotId,
  status: JobStatus,
  roles: z.object({
    interviewer: JobRoleSeat,
    searcher: JobRoleSeat,
    checker: JobRoleSeat,
    visual: JobRoleSeat,
  }),
  profile: JobProfile,
  cards: z.array(JobCard),
  /** Fingerprints of every job ever shown (Not for me included), newest last. */
  seen: z.array(z.string()).max(MAX_SEEN_JOBS),
  siteNotes: z.array(SiteNote).max(MAX_SITE_NOTES),
  /** Pages that led nowhere, skipped by later scans for a while. */
  deadPages: z.array(DeadPage).max(MAX_DEAD_PAGES).default([]),
  /** The interview's topics the Interviewer asked about, and those you skipped: not asked again. */
  interview: z
    .object({ asked: z.array(z.string()).max(20), skipped: z.array(z.string()).max(20) })
    .default({ asked: [], skipped: [] }),
  /** Searches run, newest last: a later scan starts with the ones not run lately. */
  searchesRun: z.array(SearchRun).max(MAX_SEARCHES_RUN).default([]),
  suggestions: z.array(ProfileSuggestion).max(MAX_SUGGESTIONS),
  scan: JobScan.nullable(),
  /** The number you asked for last time: suggested next time. */
  lastTarget: z.number().int().min(1).max(MAX_JOB_TARGET),
  /** The bot asked "how many new jobs?" in its chat and waits for the number. */
  askingCount: z.boolean(),
  /** Who is working now and on which page. */
  active: z.object({ role: JobRole, url: z.string().nullable(), since: z.iso.datetime() }).nullable(),
  /** A page that needs you; the scan waits until you continue or skip. */
  handoff: z.object({ url: z.string(), reason: z.string(), since: z.iso.datetime() }).nullable(),
  log: z.array(z.object({ at: z.iso.datetime(), text: z.string() })).max(MAX_JOB_LOG),
  note: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.iso.datetime(),
});
export type JobProject = z.infer<typeof JobProject>;

const RoleModel = z.object({ model: ModelRef.nullable().optional() });

export const CreateJobBotInput = z.object({
  name: BotName,
  /** Every role's model unless a role names its own; null: the shared model. */
  model: ModelRef.nullable().optional(),
  roles: z
    .object({ interviewer: RoleModel, searcher: RoleModel, checker: RoleModel, visual: RoleModel })
    .partial()
    .optional(),
});
export type CreateJobBotInput = z.infer<typeof CreateJobBotInput>;

/**
 * A change to the profile: only the fields sent. Written out without defaults on purpose: `JobProfile.partial()`
 * still fills every missing field with its default, so changing one field emptied all the others (your job titles
 * went when you changed your seniority on the profile card).
 */
export const UpdateJobProfileInput = z
  .object({
    titles: List(80, 10),
    relatedTitles: List(80, 15),
    mustHaves: List(200, 20),
    niceToHaves: List(200, 20),
    dealBreakers: List(200, 20),
    minSalary: SalaryFloor.nullable(),
    workplace: z.array(Workplace).max(3),
    places: List(100, 10),
    travel: Short(200),
    rightToWork: Short(300),
    seniority: Short(80),
    avoidIndustries: List(100, 20),
    avoidCompanies: List(100, 50),
    languages: List(60, 10),
    experience: Short(2000),
  })
  .partial();
export type UpdateJobProfileInput = z.infer<typeof UpdateJobProfileInput>;

export const StartJobScanInput = z.object({
  target: z.number().int().min(1).max(MAX_JOB_TARGET),
});
export type StartJobScanInput = z.infer<typeof StartJobScanInput>;

export const ReactToJobInput = z.object({
  reaction: z.enum(["up", "down"]).nullable(),
  reason: z.string().trim().max(200).optional(),
});
export type ReactToJobInput = z.infer<typeof ReactToJobInput>;

export const MoveJobInput = z.object({ column: JobColumn });
export type MoveJobInput = z.infer<typeof MoveJobInput>;

export const HandoffAnswerInput = z.object({ action: z.enum(["continue", "skip"]) });
export type HandoffAnswerInput = z.infer<typeof HandoffAnswerInput>;

/** A scan is working while one of these is the status. */
export const isJobBusy = (status: JobStatus) => status === "scanning" || status === "waiting_for_you";
