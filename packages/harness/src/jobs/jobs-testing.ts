import type { PageRead } from "@mrog/jobs";
import type { Bot, JobProject } from "@mrog/shared";

import { auth, fakeOllama, makeHarness, ndjson, type TestHarness } from "../testing";
import type { PageReader } from "./readers/types";

/**
 * Helpers for the Job Bot tests: a scripted team behind the fake Ollama and saved, made-up pages instead of the web
 * (no real company, recruiter or posting text, and never a live job site).
 */

export type JobRoleName = "interviewer" | "searcher" | "checker" | "visual" | "other";

export interface Seen {
  role: JobRoleName;
  fresh: boolean;
  task: string;
  tools: string[];
  think: unknown;
  system: string;
}

export interface CheckerArgs {
  kind: "job" | "list" | "other";
  facts?: { name: string; value: string; quote: string }[];
  verdicts?: { id: string; verdict: string; reason?: string }[];
  summary?: string;
  company?: { text: string; quote: string }[];
  links?: string[];
}

export interface JobBehave {
  /** The Interviewer's save_profile arguments (none: it only talks) and its words. */
  interview(said: string, nth: number): { profile?: Record<string, unknown>; say?: string };
  plan(nth: number): { searches: string[]; careerPages?: string[] } | null;
  /** The Checker's report on a page, by its address; null: it calls nothing; "fail": the model fails. */
  check(url: string, task: string): CheckerArgs | null | "fail";
}

const call = (name: string, args: unknown) => [
  { message: { tool_calls: [{ function: { name, arguments: args } }] } },
];
const text = (words: string) => [{ message: { content: words } }];

const ROLE = /You are the (Interviewer|Searcher|Checker|Visual helper) of a Job Bot/;

export function jobTeam(over: Partial<JobBehave> = {}) {
  const behave: JobBehave = {
    interview: () => ({ say: "What job do you want?" }),
    plan: () => ({ searches: ["backend engineer jobs leeds"] }),
    check: () => ({ kind: "other" }),
    ...over,
  };
  const seen: Seen[] = [];
  let interviews = 0;
  let plans = 0;
  const handlers = fakeOllama(async (body) => {
    const system: string = body.messages[0]?.content ?? "";
    const found = ROLE.exec(system)?.[1];
    const role = (found === "Visual helper" ? "visual" : (found?.toLowerCase() ?? "other")) as JobRoleName;
    const messages: { role: string; content: string }[] = body.messages;
    const firstUser = messages.findIndex((m) => m.role === "user");
    const task = messages[firstUser]?.content ?? "";
    const done = messages.slice(firstUser + 1).filter((m) => m.role === "tool").length;
    seen.push({
      role,
      fresh: done === 0,
      task,
      tools: (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
      think: body.think,
      system,
    });
    let rows: unknown[];
    if (role === "interviewer") {
      const said = /THE USER SAID\n([\s\S]*)$/.exec(task)?.[1] ?? "";
      const act = behave.interview(said, done === 0 ? ++interviews : interviews);
      rows = done === 0 && act.profile ? call("save_profile", act.profile) : text(act.say ?? "Noted.");
    } else if (role === "searcher") {
      const plan = done === 0 ? behave.plan(++plans) : null;
      rows = plan ? call("plan_searches", { careerPages: [], ...plan }) : text("Planned.");
    } else if (role === "checker") {
      const url = /^ADDRESS: (.+)$/m.exec(task)?.[1] ?? "";
      const report = done === 0 ? behave.check(url, task) : null;
      if (report === "fail") return new Response("the model crashed", { status: 500 });
      rows = report ? call("finish_job", report) : text("Checked.");
    } else rows = text("Done.");
    return ndjson([...rows, { done: true, prompt_eval_count: 100, eval_count: 10 }]);
  });
  return { handlers, seen, behave };
}

/** A page as a reader would bring it back. */
export const page = (url: string, body: string, over: Partial<PageRead> = {}): PageRead => ({
  url,
  title: body.split("\n", 1)[0] ?? "",
  text: body,
  links: [],
  reader: "text",
  humanCheck: false,
  ...over,
});

/** Long enough that the ladder counts it as loaded. */
export const pad = (body: string) =>
  `${body}\n\n${"We build robots for warehouses and hire kind people. ".repeat(12)}`;

export const SITE = "https://jobs.northwind-robotics.example";
export const BACKEND = `${SITE}/careers/backend-1`;
export const DESIGNER = `${SITE}/careers/designer-2`;
export const LIST = `${SITE}/careers`;

export const BACKEND_PAGE = pad(`Senior Backend Engineer
Northwind Robotics
Location: Leeds, United Kingdom (Hybrid - 2 days in the office)
Salary: £55,000 – £65,000 per year
Posted 3 days ago
You will build APIs in Python.`);

export const DESIGNER_PAGE = pad(`Product Designer
Northwind Robotics
Location: Leeds, United Kingdom
Salary competitive`);

export const LIST_PAGE = pad(`Jobs at Northwind Robotics
Senior Backend Engineer (${BACKEND})
Product Designer (${DESIGNER})`);

/** The Checker's honest report on the backend posting. */
export const BACKEND_REPORT: CheckerArgs = {
  kind: "job",
  facts: [
    { name: "title", value: "Senior Backend Engineer", quote: "Senior Backend Engineer" },
    { name: "company", value: "Northwind Robotics", quote: "Northwind Robotics" },
    { name: "location", value: "Leeds", quote: "Location: Leeds, United Kingdom" },
    { name: "salary", value: "£55,000 – £65,000 a year", quote: "Salary: £55,000 – £65,000 per year" },
    { name: "posted", value: "3 days ago", quote: "Posted 3 days ago" },
  ],
  verdicts: [
    { id: "r1", verdict: "meets", reason: "Same title." },
    { id: "r2", verdict: "meets", reason: "Hybrid." },
  ],
  summary: "Backend role building APIs in Python.",
  company: [{ text: "Builds warehouse robots", quote: "We build robots for warehouses" }],
};

/** Readers that serve saved pages: `text` for every address it knows, `browser` for the rest. */
export function savedReaders(pages: {
  text?: Record<string, PageRead | Error>;
  browser?: Record<string, PageRead | Error>;
}): Record<"text" | "browser", PageReader> & { calls: string[] } {
  const calls: string[] = [];
  const reader = (id: "text" | "browser", map: Record<string, PageRead | Error> = {}): PageReader => ({
    id,
    async read(url) {
      calls.push(`${id} ${url}`);
      const found = map[url];
      if (!found) throw new Error(`no saved page for ${url}`);
      if (found instanceof Error) throw found;
      return { ...found, reader: id };
    },
  });
  return { text: reader("text", pages.text), browser: reader("browser", pages.browser), calls };
}

/** A harness with the scripted team, a shared model and no real web. */
export async function jobHarness(team: ReturnType<typeof jobTeam>): Promise<TestHarness> {
  const h = await makeHarness({ handlers: team.handlers });
  h.store.settings.set("runtime", {
    ...h.store.settings.get<Record<string, unknown>>("runtime"),
    sharedModel: "ollama:test:1b",
  });
  h.services.jobs.io.readers = {};
  h.services.jobs.io.search = async () => null;
  return h;
}

export const post = (h: TestHarness, url: string, payload?: Record<string, unknown>) =>
  h.app.inject({ method: "POST", url, headers: auth, ...(payload === undefined ? {} : { payload }) });

export const patch = (h: TestHarness, url: string, payload: Record<string, unknown>) =>
  h.app.inject({ method: "PATCH", url, headers: auth, payload });

/** Creates a Job Bot through the API. */
export async function makeJobBot(h: TestHarness, over: Record<string, unknown> = {}) {
  const res = await post(h, "/api/job-bots", { name: "Scout", ...over });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
  return res.json() as { bot: Bot; project: JobProject };
}

/** A Job Bot whose profile is approved and ready to scan. */
export async function readyJobBot(h: TestHarness) {
  const made = await makeJobBot(h);
  await patch(h, `/api/bots/${made.bot.id}/job/profile`, {
    titles: ["Backend Engineer"],
    workplace: ["hybrid"],
  });
  await post(h, `/api/bots/${made.bot.id}/job/profile/approve`);
  return made;
}

export const projectOf = (h: TestHarness, botId: string) => h.services.jobs.get(botId)!;

/** Waits until the project satisfies `match` (polling, so a missed event can't hang a test). */
export async function until(
  h: TestHarness,
  botId: string,
  match: (project: JobProject) => boolean,
  timeoutMs = 10_000,
): Promise<JobProject> {
  const start = Date.now();
  for (;;) {
    const project = projectOf(h, botId);
    if (match(project)) return project;
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `Timed out. Project is ${project.status}: ${project.log.map((l) => l.text).join(" | ")}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** Types a message in a bot's own chat. */
export const type = (h: TestHarness, bot: Bot, words: string) =>
  post(h, `/api/threads/${bot.threadId}/messages`, { text: words });

/** The Job Bot's own messages in its chat, oldest first. */
export const botSaid = (h: TestHarness, bot: Bot) =>
  h.store.messages
    .list(bot.threadId)
    .filter((m) => m.role === "bot")
    .map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
