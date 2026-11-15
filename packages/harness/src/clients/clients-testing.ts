import type { PageRead } from "@mrog/jobs";
import type { Bot, ClientProject } from "@mrog/shared";

import { fakeOllama, ndjson, makeHarness, type TestHarness } from "../testing";
import { auth } from "../testing";
import type { PageReader } from "../jobs/readers/types";

/**
 * Helpers for the Client Bot tests: a scripted team behind the fake Ollama and saved, made-up pages and register
 * answers instead of the web. Every company, person and address here is invented (.test domains).
 */

export type ClientRoleName = "interviewer" | "searcher" | "checker" | "visual" | "other";

export interface CheckerArgs {
  kind: "company" | "request" | "signal" | "list" | "competitor" | "other";
  facts?: { name: string; value: string; quote: string }[];
  signals?: { kind: string; quote: string; date?: string }[];
  traits?: { id: string; quote: string }[];
  verdicts?: { id: string; verdict: string; reason?: string }[];
  website?: string;
  summary?: string;
  links?: string[];
}

export interface ClientBehave {
  interview(said: string, nth: number): { profile?: Record<string, unknown>; say?: string };
  plan(nth: number): { searches: string[] } | null;
  check(url: string, task: string): CheckerArgs | null | "fail";
}

const call = (name: string, args: unknown) => [
  { message: { tool_calls: [{ function: { name, arguments: args } }] } },
];
const text = (words: string) => [{ message: { content: words } }];
const ROLE = /You are the (Interviewer|Searcher|Checker|Visual helper) of a Client Bot/;

export function clientTeam(over: Partial<ClientBehave> = {}) {
  const behave: ClientBehave = {
    interview: () => ({ say: "What do you sell?" }),
    plan: () => ({ searches: [] }),
    check: () => ({ kind: "other" }),
    ...over,
  };
  const seen: { role: ClientRoleName; task: string; tools: string[] }[] = [];
  let interviews = 0;
  let plans = 0;
  const handlers = fakeOllama(async (body) => {
    const system: string = body.messages[0]?.content ?? "";
    const found = ROLE.exec(system)?.[1];
    const role = (found === "Visual helper" ? "visual" : (found?.toLowerCase() ?? "other")) as ClientRoleName;
    const messages: { role: string; content: string }[] = body.messages;
    const firstUser = messages.findIndex((m) => m.role === "user");
    const task = messages[firstUser]?.content ?? "";
    const done = messages.slice(firstUser + 1).filter((m) => m.role === "tool").length;
    seen.push({
      role,
      task,
      tools: (body.tools ?? []).map((t: { function: { name: string } }) => t.function.name),
    });
    let rows: unknown[];
    if (role === "interviewer") {
      const said = /THE USER SAID\n([\s\S]*)$/.exec(task)?.[1] ?? "";
      const act = behave.interview(said, done === 0 ? ++interviews : interviews);
      rows = done === 0 && act.profile ? call("save_offer", act.profile) : text(act.say ?? "Noted.");
    } else if (role === "searcher") {
      const plan = done === 0 ? behave.plan(++plans) : null;
      rows = plan ? call("plan_searches", plan) : text("Planned.");
    } else if (role === "checker") {
      const url = /^ADDRESS: (.+)$/m.exec(task)?.[1] ?? "";
      const report = done === 0 ? behave.check(url, task) : null;
      if (report === "fail") return new Response("the model crashed", { status: 500 });
      rows = report ? call("finish_page", report) : text("Checked.");
    } else rows = text("Done.");
    return ndjson([...rows, { done: true, prompt_eval_count: 100, eval_count: 10 }]);
  });
  return { handlers, seen, behave };
}

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
  `${body}\n\n${"We are a friendly local business and love our customers. ".repeat(12)}`;

export const NEWS = "https://news.test/leeds/brightside-hiring";
export const SITE = "https://brightside-kitchens.test/";
export const RIVAL = "https://payroll-pals.test/";
export const PINE = "https://pinecafe.test/";

export const NEWS_PAGE = pad(`Brightside Kitchens is hiring
Published 3 November 2026
Leeds restaurant group Brightside Kitchens is advertising for a Payroll Administrator to join its team.`);

const navLinks = (base: string) =>
  ["About", "Menu", "Contact us", "Careers", "Gallery", "Find us"].map((label) => ({
    text: label,
    url: `${base}${label.toLowerCase().replace(/ /g, "-")}`,
  }));

export const SITE_PAGE = pad(`Brightside Kitchens
A family restaurant group in Leeds. Our team of 30 serves three restaurants.
Say hello@brightside-kitchens.test or call Tel: 0113 496 0000.
© 2018 Brightside Kitchens Ltd`);

export const RIVAL_PAGE = pad(`Payroll Pals
We offer payroll services to restaurants across Leeds.`);

export const PINE_PAGE = pad(`Pine Cafe
Two cafes in Leeds, a team of 12 staff.
Email info@pinecafe.test`);

export const NEWS_REPORT: CheckerArgs = {
  kind: "signal",
  facts: [
    { name: "company", value: "Brightside Kitchens", quote: "Leeds restaurant group Brightside Kitchens" },
    { name: "place", value: "Leeds", quote: "Leeds restaurant group" },
  ],
  signals: [{ kind: "hiring", quote: "advertising for a Payroll Administrator", date: "3 November 2026" }],
  summary: "A Leeds restaurant group hiring payroll help.",
};

export const SITE_REPORT: CheckerArgs = {
  kind: "company",
  facts: [
    { name: "company", value: "Brightside Kitchens", quote: "Brightside Kitchens" },
    { name: "place", value: "Leeds", quote: "A family restaurant group in Leeds" },
    { name: "size", value: "30 staff", quote: "Our team of 30" },
    { name: "industry", value: "Restaurants", quote: "Our team of 30 serves three restaurants" },
  ],
  traits: [{ id: "has_staff", quote: "Our team of 30" }],
  verdicts: [
    { id: "r1", verdict: "meets", reason: "Restaurants." },
    { id: "r2", verdict: "meets", reason: "Leeds." },
  ],
  summary: "Family restaurant group in Leeds.",
};

export const PINE_REPORT: CheckerArgs = {
  kind: "company",
  facts: [
    { name: "company", value: "Pine Cafe", quote: "Pine Cafe" },
    { name: "place", value: "Leeds", quote: "Two cafes in Leeds" },
    { name: "size", value: "12 staff", quote: "a team of 12 staff" },
    { name: "industry", value: "Cafes", quote: "Two cafes in Leeds" },
  ],
  traits: [{ id: "has_staff", quote: "a team of 12 staff" }],
  verdicts: [{ id: "r1", verdict: "meets", reason: "Cafés are restaurants." }],
};

/** Readers that serve saved pages: `text` for every address it knows. */
export function savedReaders(pages: Record<string, PageRead | Error>): { text: PageReader; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    text: {
      id: "text",
      async read(url) {
        calls.push(url);
        const found = pages[url];
        if (!found) throw new Error(`no saved page for ${url}`);
        if (found instanceof Error) throw found;
        return { ...found, reader: "text" };
      },
    },
  };
}

export const SITE_PAGES = () => ({
  [NEWS]: page(NEWS, NEWS_PAGE),
  [SITE]: page(SITE, SITE_PAGE, { links: navLinks(SITE) }),
  [RIVAL]: page(RIVAL, RIVAL_PAGE),
  [PINE]: page(PINE, PINE_PAGE, { links: navLinks(PINE) }),
});

/** A harness with the scripted team, a shared model and no real web: no searches, no register answers. */
export async function clientHarness(team: ReturnType<typeof clientTeam>): Promise<TestHarness> {
  const h = await makeHarness({ handlers: team.handlers });
  h.store.settings.set("runtime", {
    ...h.store.settings.get<Record<string, unknown>>("runtime"),
    sharedModel: "ollama:test:1b",
  });
  h.services.clients.io.readers = {};
  h.services.clients.io.search = async () => null;
  h.services.clients.io.fetch = async () => null;
  return h;
}

export const post = (h: TestHarness, url: string, payload?: Record<string, unknown>) =>
  h.app.inject({ method: "POST", url, headers: auth, ...(payload === undefined ? {} : { payload }) });

export const patch = (h: TestHarness, url: string, payload: Record<string, unknown>) =>
  h.app.inject({ method: "PATCH", url, headers: auth, payload });

export async function makeClientBot(h: TestHarness, over: Record<string, unknown> = {}) {
  const res = await post(h, "/api/client-bots", { name: "Finder", ...over });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
  return res.json() as { bot: Bot; project: ClientProject };
}

/** A payroll Client Bot for Leeds restaurants, approved and ready to scan. */
export async function readyClientBot(h: TestHarness, over: Record<string, unknown> = {}) {
  const made = await makeClientBot(h);
  const res = await patch(h, `/api/bots/${made.bot.id}/client/profile`, {
    offer: "Outsourced payroll for restaurants",
    areas: ["Leeds"],
    industries: ["restaurants"],
    sizeMin: 5,
    sizeMax: 100,
    ...over,
  });
  if (res.statusCode !== 200) throw new Error(`profile failed: ${res.body}`);
  const approved = await post(h, `/api/bots/${made.bot.id}/client/profile/approve`);
  if (approved.statusCode !== 200) throw new Error(`approve failed: ${approved.body}`);
  return made;
}

export const projectOf = (h: TestHarness, botId: string) => h.services.clients.get(botId)!;

export async function until(
  h: TestHarness,
  botId: string,
  match: (project: ClientProject) => boolean,
  timeoutMs = 10_000,
): Promise<ClientProject> {
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

/** Starts a scan and waits for it to end. */
export async function scan(h: TestHarness, botId: string, target: number, kinds?: string[]) {
  const res = await post(h, `/api/bots/${botId}/client/scan`, { target, ...(kinds ? { kinds } : {}) });
  if (res.statusCode !== 200) throw new Error(`scan failed: ${res.body}`);
  await h.services.clients.idle(botId);
  return projectOf(h, botId);
}

export const type = (h: TestHarness, bot: Bot, words: string) =>
  post(h, `/api/threads/${bot.threadId}/messages`, { text: words });

export const botSaid = (h: TestHarness, bot: Bot) =>
  h.store.messages
    .list(bot.threadId)
    .filter((m) => m.role === "bot")
    .map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
