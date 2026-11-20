import { factValue } from "@mrog/jobs";
import { afterEach, describe, expect, it } from "vitest";

import { auth, type TestHarness } from "../testing";
import {
  BACKEND,
  BACKEND_PAGE,
  BACKEND_REPORT,
  botSaid,
  DESIGNER,
  DESIGNER_PAGE,
  jobHarness,
  jobTeam,
  LIST,
  LIST_PAGE,
  makeJobBot,
  pad,
  page,
  patch,
  post,
  projectOf,
  readyJobBot,
  savedReaders,
  SITE,
  type,
  until,
} from "./jobs-testing";

let h: TestHarness;
afterEach(async () => {
  await h?.close();
});

const listPage = () =>
  page(LIST, LIST_PAGE, {
    links: [
      { text: "Senior Backend Engineer", url: BACKEND },
      { text: "Product Designer", url: DESIGNER },
    ],
  });

/**
 * The Checker of the saved site: the list, an honest report on the backend job, an invented salary on the other.
 * `designerFits` false: the designer job is the wrong title (a weak match that doesn't count).
 */
const siteChecker = (url: string, designerFits = true) =>
  url === LIST
    ? { kind: "list" as const, links: [BACKEND, DESIGNER, `${SITE}/careers/made-up-9`] }
    : url === BACKEND
      ? BACKEND_REPORT
      : url === DESIGNER
        ? {
            kind: "job" as const,
            facts: [
              { name: "title", value: "Product Designer", quote: "Product Designer" },
              { name: "company", value: "Northwind Robotics", quote: "Northwind Robotics" },
              { name: "salary", value: "£80,000", quote: "Salary competitive" },
            ],
            verdicts: [
              { id: "r1", verdict: designerFits ? "meets" : "misses", reason: "The title." },
              { id: "r2", verdict: "meets", reason: "Hybrid." },
            ],
          }
        : { kind: "other" as const };

/** Serves the saved site: one search finds the list page. */
function serveSite(target: TestHarness, extra: Parameters<typeof savedReaders>[0] = {}) {
  const readers = savedReaders({
    text: {
      [LIST]: listPage(),
      [BACKEND]: page(BACKEND, BACKEND_PAGE),
      [DESIGNER]: page(DESIGNER, DESIGNER_PAGE),
      ...extra.text,
    },
    browser: extra.browser,
  });
  target.services.jobs.io.readers = { text: readers.text, browser: readers.browser };
  target.services.jobs.io.search = async () => [LIST];
  return readers;
}

describe("creating a Job Bot", () => {
  it("makes a hidden team, each role with one tool, its own thread, and greets you", async () => {
    h = await jobHarness(jobTeam());
    const { bot, project } = await makeJobBot(h);
    expect(project.status).toBe("interview");
    const tools = Object.fromEntries(
      Object.entries(project.roles).map(([role, seat]) => [role, h.store.bots.get(seat.botId)!.tools.allow]),
    );
    expect(tools).toEqual({
      interviewer: ["save_profile"],
      searcher: ["plan_searches"],
      checker: ["finish_job"],
      visual: ["screen_look", "screen_scroll", "screen_click", "screen_back"],
    });
    for (const seat of Object.values(project.roles)) {
      const roleBot = h.store.bots.get(seat.botId)!;
      expect(roleBot).toMatchObject({
        hidden: true,
        temporary: false,
        parentId: bot.id,
        notifications: false,
      });
    }
    expect(h.store.bots.get(project.roles.visual.botId)!.visual).toBe(true);
    const pairs = h.store.threads.list().filter((t) => t.pair && t.memberIds.includes(bot.id));
    expect(pairs.map((t) => t.title).toSorted()).toEqual([
      "Scout ↔ Checker",
      "Scout ↔ Interviewer",
      "Scout ↔ Searcher",
      "Scout ↔ Visual helper",
    ]);
    expect(botSaid(h, bot)[0]).toMatch(/^Hi, I'm Scout\. Tell me about the job you want/);
    expect(h.services.turns.extensions.refuses?.(bot)).toMatch(/runs its team/);
  });

  it("refuses a name in use, or one too long for the team's names", async () => {
    h = await jobHarness(jobTeam());
    await makeJobBot(h);
    expect((await post(h, "/api/job-bots", { name: "Scout" })).json().message).toMatch(/already exists/);
    expect((await post(h, "/api/job-bots", { name: "x".repeat(50) })).json().message).toMatch(/too long/);
  });
});

describe("the interview", () => {
  it("saves what you say, and the profile is ready once it has titles and a workplace", async () => {
    const team = jobTeam({
      interview: (_said, nth) =>
        nth === 1
          ? { profile: { titles: ["Backend Engineer"], workplace: ["hybrid"] }, say: "Great. Anything else?" }
          : {},
    });
    h = await jobHarness(team);
    const { bot } = await makeJobBot(h);
    await type(h, bot, "Backend engineer jobs, hybrid please");
    const project = await until(h, bot.id, (p) => p.status === "awaiting_profile");
    expect(project.profile.titles).toEqual(["Backend Engineer"]);
    await until(h, bot.id, () => botSaid(h, bot).some((said) => said.startsWith("Great. Anything else?")));
    expect(botSaid(h, bot).at(-1)).toMatch(/approve it on the profile card/);
    const turn = team.seen.find((s) => s.role === "interviewer" && s.fresh)!;
    expect(turn.tools).toEqual(["save_profile"]);
    expect(turn.task).toMatch(/THE USER SAID\nBackend engineer jobs, hybrid please$/);
  });

  it("asks once more to save when the Interviewer replied without saving", async () => {
    const team = jobTeam({
      interview: (_said, nth) =>
        nth === 1
          ? { say: "Got it! What seniority?" }
          : { profile: { titles: ["Backend Engineer"], workplace: ["remote"] } },
    });
    h = await jobHarness(team);
    const { bot } = await makeJobBot(h);
    await type(h, bot, "Backend engineer, remote");
    const project = await until(h, bot.id, (p) => p.status === "awaiting_profile");
    expect(project.profile.workplace).toEqual(["remote"]);
    const turns = team.seen.filter((s) => s.role === "interviewer" && s.fresh);
    expect(turns).toHaveLength(2);
    expect(turns[1]!.task).toContain("You replied without calling save_profile");
    // You see the first reply's words; the second turn only saved.
    await until(h, bot.id, () => botSaid(h, bot).some((said) => said.startsWith("Got it! What seniority?")));
  });

  it("doesn't ask again when the Interviewer saved", async () => {
    const team = jobTeam({ interview: () => ({ profile: { titles: ["Backend Engineer"] }, say: "Where?" }) });
    h = await jobHarness(team);
    const { bot } = await makeJobBot(h);
    await type(h, bot, "Backend engineer");
    await until(h, bot.id, (p) => p.profile.titles.length === 1);
    await until(h, bot.id, () => botSaid(h, bot).some((said) => said.startsWith("Where?")));
    expect(team.seen.filter((s) => s.role === "interviewer" && s.fresh)).toHaveLength(1);
  });

  it("changes only the fields sent: editing one doesn't empty the others", async () => {
    h = await jobHarness(jobTeam());
    const { bot } = await readyJobBot(h);
    // Before: this emptied the titles and the workplace (the input filled every missing field with its default).
    const res = await patch(h, `/api/bots/${bot.id}/job/profile`, { seniority: "Senior" });
    expect(res.json().project.profile).toMatchObject({
      seniority: "Senior",
      titles: ["Backend Engineer"],
      workplace: ["hybrid"],
    });
  });

  it("tells the Interviewer its last question, adds list items, and remembers a skip", async () => {
    const team = jobTeam({
      interview: (said, nth) =>
        nth === 1
          ? { profile: { titles: ["Backend Engineer"], mustHaves: ["Python"] } }
          : nth === 2
            ? // A small model sends only the new item, as before: it must not wipe Python.
              { profile: { mustHaves: ["Go"] } }
            : { say: "OK." },
    });
    h = await jobHarness(team);
    const { bot } = await makeJobBot(h);
    const reply = async (words: string) => {
      const before = botSaid(h, bot).length;
      await type(h, bot, words);
      const start = Date.now();
      while (
        botSaid(h, bot).length <= before ||
        h.store.messages.list(bot.threadId).at(-1)?.status === "streaming"
      ) {
        if (Date.now() - start > 5000) throw new Error("no reply");
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    };
    await reply("Backend Engineer jobs, must know Python");
    await reply("also add Go");
    expect(projectOf(h, bot.id).profile.mustHaves).toEqual(["Python", "Go"]);
    expect(botSaid(h, bot).at(-1)).toContain("Saved: Added must-have: Go");
    const asked = team.seen.filter((s) => s.role === "interviewer").at(-1)!.task;
    expect(asked).toContain("YOU LAST ASKED (the user is answering this)");
    // The bot's last words before "skip" asked about salary: that topic is skipped from now on.
    h.store.messages.create({
      threadId: bot.threadId,
      role: "bot",
      botId: bot.id,
      parts: [{ type: "text", text: "What's the lowest salary you'd take?" }],
    });
    await reply("skip");
    const after = team.seen.filter((s) => s.role === "interviewer").at(-1)!.task;
    expect(after).toContain("THE USER SKIPPED (leave these empty, don't ask again): lowest salary");
  });

  it("won't scan before you approve the profile", async () => {
    h = await jobHarness(jobTeam());
    const { bot } = await makeJobBot(h);
    await patch(h, `/api/bots/${bot.id}/job/profile`, {
      titles: ["Backend Engineer"],
      workplace: ["remote"],
    });
    const res = await post(h, `/api/bots/${bot.id}/job/scan`, { target: 5 });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/Approve your profile first/);
    expect((await post(h, `/api/bots/${bot.id}/job/profile/approve`)).json().project.status).toBe("ready");
  });
});

describe("a scan", () => {
  it("reads a list page, checks every fact against the page, and stops at the number you asked for", async () => {
    const team = jobTeam({ check: (url) => siteChecker(url) });
    h = await jobHarness(team);
    const { bot } = await readyJobBot(h);
    const readers = serveSite(h);
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 2 });
    const project = await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    expect(project.scan).toMatchObject({ number: 1, target: 2, found: 2, stopReason: "Found 2 new jobs." });
    const backend = project.cards.find((c) => c.url === BACKEND)!;
    expect(backend).toMatchObject({
      readBy: "text",
      column: "found",
      site: "jobs.northwind-robotics.example",
    });
    expect(factValue(backend.facts, "salary")).toBe("£55,000 – £65,000 a year");
    expect(backend.score).toBe(100);
    expect(backend.company).toEqual([
      { text: "Builds warehouse robots", quote: "We build robots for warehouses" },
    ]);
    // An invented salary next to a real quote is "not stated", and so a warning.
    const designer = project.cards.find((c) => c.url === DESIGNER)!;
    expect(factValue(designer.facts, "salary")).toBeNull();
    expect(designer.warnings.map((w) => w.id)).toContain("no-salary");
    // A link the Checker made up was never read.
    expect(readers.calls.some((c) => c.includes("made-up-9"))).toBe(false);
    // The Checker's thread keeps each task, but no longer the whole page once it is checked.
    const checker = h.store.bots.get(project.roles.checker.botId)!;
    const pair = h.store.threads.list().find((t) => t.pair && t.memberIds.includes(checker.id))!;
    const tasks = h.store.messages.list(pair.id).filter((m) => m.botId === bot.id);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((m) => m.parts.some((p) => p.type === "text" && p.text.includes("ADDRESS:")))).toBe(
      true,
    );
    const checks = team.seen.filter((s) => s.role === "checker" && s.fresh);
    expect(checks.every((s) => s.tools.join() === "finish_job" && s.think === false)).toBe(true);
    expect(botSaid(h, bot).at(-1)).toMatch(
      /Found 2 new jobs\.\n\nStrongest new matches:\n- Senior Backend Engineer at Northwind Robotics: 100 \(strong\)/,
    );
  });

  it("tells a Checker that answered in words, once and in the same turn, to call finish_job", async () => {
    let backendTries = 0;
    const team = jobTeam({
      check: (url) => {
        if (url !== BACKEND) return siteChecker(url);
        // The first time it only talks; told to call its tool, it reports.
        backendTries += 1;
        return backendTries === 1 ? null : BACKEND_REPORT;
      },
    });
    h = await jobHarness(team);
    const { bot } = await readyJobBot(h);
    serveSite(h);
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 1 });
    const project = await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    expect(project.cards.some((c) => c.url === BACKEND)).toBe(true);
    const asked = team.seen.filter((s) => s.role === "checker" && s.task.includes(`ADDRESS: ${BACKEND}`));
    // Asked twice before it reported (the nudge, in the same turn), then its closing sentence. Before: the page was
    // given up after the first answer.
    expect(asked.filter((s) => s.fresh)).toHaveLength(2);
    expect(backendTries).toBe(2);
  });

  it("picks the jobs you want from a job system's list by code, with no Checker turn on the list", async () => {
    const board = "https://boards.greenhouse.io/acme";
    const posting = (n: number) => `https://boards.greenhouse.io/acme/jobs/${n}`;
    const titles = ["Data Analyst", "Backend Engineer", "Sales Lead", "Senior Backend Engineer", "Designer"];
    const team = jobTeam({
      check: (url) => (url.startsWith(posting(0).slice(0, -1)) ? BACKEND_REPORT : { kind: "other" }),
    });
    h = await jobHarness(team);
    const { bot } = await readyJobBot(h);
    const read: string[] = [];
    h.services.jobs.io.readers = {
      api: {
        id: "api",
        async read(url) {
          read.push(url);
          if (url === board)
            return page(board, titles.map((t, i) => `${t} (${posting(i + 1)})`).join(" / "), {
              reader: "api",
              links: titles.map((text, i) => ({ text, url: posting(i + 1) })),
            });
          return page(url, BACKEND_PAGE, { reader: "api" });
        },
      },
    };
    h.services.jobs.io.search = async () => [board];
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 1 });
    const project = await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    // Only backend jobs are read (the scan stops at the first, as asked); the list never goes to the Checker.
    const postings = read.filter((u) => u !== board);
    expect(postings.length).toBeGreaterThan(0);
    expect(postings.every((u) => u === posting(2) || u === posting(4))).toBe(true);
    const addresses = team.seen
      .filter((s) => s.role === "checker")
      .map((s) => /^ADDRESS: (.+)$/m.exec(s.task)?.[1]);
    expect(addresses).not.toContain(board);
    expect(project.log.map((l) => l.text)).toContain(
      "boards.greenhouse.io lists 5 jobs: 2 new ones fit your titles",
    );
  });

  it("doesn't read a page that led nowhere again in a later scan, but always reads a list again", async () => {
    const blog = `${SITE}/careers/life-at-northwind`;
    const team = jobTeam({ check: (url) => siteChecker(url) });
    h = await jobHarness(team);
    const { bot } = await readyJobBot(h);
    const readers = serveSite(h, { text: { [blog]: page(blog, pad("Life at Northwind. Our values.")) } });
    h.services.jobs.io.search = async () => [LIST, blog];
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 5 });
    let project = await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    expect(project.deadPages.map((d) => d.reason)).toContain("not a job");
    expect(project.deadPages.some((d) => d.key.endsWith("/careers"))).toBe(false);
    const firstReads = readers.calls.length;
    // A new related title gives the second scan searches it hasn't run yet.
    await patch(h, `/api/bots/${bot.id}/job/profile`, { relatedTitles: ["Platform Engineer"] });
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 5 });
    project = await until(h, bot.id, (p) => p.status === "ready" && p.scan?.number === 2 && !!p.scan.endedAt);
    const again = readers.calls.slice(firstReads);
    // Before: the page was read and checked again in every scan.
    expect(again.some((c) => c.endsWith(blog))).toBe(false);
    expect(again.some((c) => c.endsWith(LIST))).toBe(true);
  });

  it("counts only jobs like yours toward the number; a weak match goes on the board uncounted", async () => {
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url, false) }));
    const { bot } = await readyJobBot(h);
    serveSite(h);
    h.services.jobs.io.limits = { ...h.services.jobs.io.limits, searchRounds: 1 };
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 2 });
    const project = await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    expect(project.scan).toMatchObject({ found: 1, weaker: 1 });
    expect(project.cards).toHaveLength(2);
    expect(project.cards.find((c) => c.url === DESIGNER)!.score).toBe(25);
    expect(botSaid(h, bot).at(-1)).toMatch(/1 weaker match also went on the board, not counted\./);
  });

  it("searches companies' own job systems first, then the Searcher's searches", async () => {
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url) }));
    const { bot } = await readyJobBot(h);
    serveSite(h);
    const queries: string[] = [];
    h.services.jobs.io.search = async (_botId, query) => {
      queries.push(query);
      return [LIST];
    };
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 2 });
    await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    expect(queries).toEqual([
      '"Backend Engineer" site:greenhouse.io',
      '"Backend Engineer" site:jobs.lever.co',
      '"Backend Engineer" site:jobs.ashbyhq.com',
      '"Backend Engineer" site:myworkdayjobs.com',
      "backend engineer jobs leeds",
    ]);
  });

  it("runs new searches in a later scan instead of the same ones again", async () => {
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url), plan: () => null }));
    const { bot } = await readyJobBot(h);
    await patch(h, `/api/bots/${bot.id}/job/profile`, { relatedTitles: ["Platform Engineer"] });
    serveSite(h);
    const queries: string[] = [];
    h.services.jobs.io.search = async (_botId, query) => {
      queries.push(query);
      return [LIST];
    };
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 2 });
    await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    const first = [...queries];
    queries.length = 0;
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 2 });
    await until(h, bot.id, (p) => p.status === "ready" && p.scan?.number === 2 && !!p.scan.endedAt);
    // Before: scan 2 ran exactly the searches of scan 1.
    expect(first.some((q) => q.startsWith('"Backend Engineer"'))).toBe(true);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => !first.includes(q))).toBe(true);
    expect(queries.some((q) => q.startsWith('"Platform Engineer"'))).toBe(true);
  });

  it("skips the rest of a site after two of its pages couldn't be used", async () => {
    const board = "https://board.example";
    const pages = [1, 2, 3].map((n) => `${board}/jobs/${n}`);
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url) }));
    const { bot } = await readyJobBot(h);
    const readers = savedReaders({
      text: Object.fromEntries(pages.map((url) => [url, page(url, "Sign in to view this job")])),
    });
    h.services.jobs.io.readers = { text: readers.text };
    h.services.jobs.io.search = async () => pages;
    h.services.jobs.io.show = async () => undefined;
    h.services.jobs.io.handoffLimitMs = 10;
    h.services.jobs.io.limits = { ...h.services.jobs.io.limits, searchRounds: 1 };
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 1 });
    const project = await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    expect(readers.calls).toEqual([`text ${pages[0]}`, `text ${pages[1]}`]);
    expect(project.log.map((l) => l.text)).toContain(
      "Skipping the rest of board.example this scan: 2 of its pages couldn't be used",
    );
  });

  it("doesn't skip a site because some of its jobs have closed", async () => {
    const board = "https://board.example";
    const gone = [1, 2].map((n) => `${board}/jobs/${n}`);
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url) }));
    const { bot } = await readyJobBot(h);
    const readers = savedReaders({
      text: {
        ...Object.fromEntries(gone.map((url) => [url, page(url, "Not found", { status: 404 })])),
        [`${board}/jobs/3`]: page(`${board}/jobs/3`, BACKEND_PAGE),
      },
    });
    h.services.jobs.io.readers = { text: readers.text };
    h.services.jobs.io.search = async () => [...gone, `${board}/jobs/3`];
    h.services.jobs.io.limits = { ...h.services.jobs.io.limits, searchRounds: 1 };
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 1 });
    await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    expect(readers.calls).toContain(`text ${board}/jobs/3`);
  });

  it("never shows the same job twice, across scans", async () => {
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url) }));
    const { bot } = await readyJobBot(h);
    serveSite(h);
    h.services.jobs.io.limits = { ...h.services.jobs.io.limits, searchRounds: 1 };
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 2 });
    await until(h, bot.id, (p) => p.status === "ready" && p.scan?.number === 1 && !!p.scan.endedAt);
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 2 });
    const project = await until(
      h,
      bot.id,
      (p) => p.status === "ready" && p.scan?.number === 2 && !!p.scan.endedAt,
    );
    expect(project.cards).toHaveLength(2);
    expect(project.scan).toMatchObject({
      found: 0,
      stopReason: "Ran out of places to look. Try again later, or widen your profile.",
    });
  });

  it("asks in chat how many new jobs to find, and starts on a number", async () => {
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url) }));
    const { bot } = await readyJobBot(h);
    serveSite(h);
    await type(h, bot, "Find me some jobs");
    expect(projectOf(h, bot.id).askingCount).toBe(true);
    expect(botSaid(h, bot).at(-1)).toBe(
      "How many new jobs should I find this time? Say a number from 1 to 50 (last time: 10).",
    );
    await type(h, bot, "1");
    const project = await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    expect(project.scan).toMatchObject({ target: 1, found: 1 });
    expect(project.lastTarget).toBe(1);
  });

  it("steps down to the browser when the text is only a shell, and remembers the site", async () => {
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url) }));
    const { bot } = await readyJobBot(h);
    const readers = serveSite(h, {
      text: { [BACKEND]: page(BACKEND, "Loading…") },
      browser: { [BACKEND]: page(BACKEND, BACKEND_PAGE) },
    });
    h.services.jobs.io.search = async () => [BACKEND];
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 1 });
    const project = await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    expect(project.cards[0]).toMatchObject({ url: BACKEND, readBy: "browser" });
    expect(readers.calls).toEqual([`text ${BACKEND}`, `browser ${BACKEND}`]);
    expect(project.siteNotes).toMatchObject([{ host: "jobs.northwind-robotics.example", reader: "browser" }]);
  });

  it("waits for you on a CAPTCHA, and carries on when you press Continue", async () => {
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url) }));
    const { bot } = await readyJobBot(h);
    // The page needs scripts as text; in the browser it shows a CAPTCHA.
    serveSite(h, {
      text: { [BACKEND]: page(BACKEND, "Loading…") },
      browser: { [BACKEND]: page(BACKEND, BACKEND_PAGE, { humanCheck: true }) },
    });
    h.services.jobs.io.search = async () => [BACKEND];
    const shown: string[] = [];
    h.services.jobs.io.show = async (_botId, url) => void shown.push(url);
    h.services.jobs.io.reread = async () => page(BACKEND, BACKEND_PAGE);
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 1 });
    const waiting = await until(h, bot.id, (p) => p.status === "waiting_for_you");
    expect(waiting.handoff).toMatchObject({
      url: BACKEND,
      reason: "The site wants a human check (a CAPTCHA).",
    });
    expect(shown).toEqual([BACKEND]);
    expect((await post(h, `/api/bots/${bot.id}/job/handoff`, { action: "continue" })).statusCode).toBe(200);
    const project = await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    expect(project.cards[0]).toMatchObject({ url: BACKEND, readBy: "you" });
    expect(project.handoff).toBeNull();
  });

  it("sets a page that needs you aside, carries on, and skips the rest once nobody answers", async () => {
    const other = "https://jobs.other-company.example/careers/7";
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url) }));
    const { bot } = await readyJobBot(h);
    serveSite(h, {
      text: { [DESIGNER]: page(DESIGNER, "Loading…"), [other]: page(other, "Loading…") },
      browser: {
        [DESIGNER]: page(DESIGNER, DESIGNER_PAGE, { humanCheck: true }),
        [other]: page(other, DESIGNER_PAGE, { humanCheck: true }),
      },
    });
    // The pages that need you come first; the job that doesn't, last.
    h.services.jobs.io.search = async () => [DESIGNER, other, BACKEND];
    h.services.jobs.io.show = async () => undefined;
    h.services.jobs.io.handoffLimitMs = 30;
    h.services.jobs.io.limits = { ...h.services.jobs.io.limits, searchRounds: 1 };
    let waitedBeforeJob = false;
    h.bus.subscribe((e) => {
      if (e.type === "job.updated" && e.project.status === "waiting_for_you" && e.project.cards.length === 0)
        waitedBeforeJob = true;
    });
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 2 });
    const project = await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    // Before: the scan stopped and waited up to 10 minutes on each such page, in turn.
    expect(waitedBeforeJob).toBe(false);
    expect(project.cards.map((c) => c.url)).toEqual([BACKEND]);
    const log = project.log.map((l) => l.text);
    expect(log.filter((l) => l.startsWith("Set aside for you"))).toHaveLength(2);
    expect(log).toContain("Nobody answered: skipped the other 1 page(s) that need you");
    // The one nobody answered and the one skipped after it.
    expect(project.scan?.stopReason).toMatch(/2 pages that needed you were left unread\.$/);
  });

  it("skips the page when you press Skip, and nothing waits when nothing is asked", async () => {
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url) }));
    const { bot } = await readyJobBot(h);
    // The page needs scripts as text; in the browser it shows a CAPTCHA.
    serveSite(h, {
      text: { [BACKEND]: page(BACKEND, "Loading…") },
      browser: { [BACKEND]: page(BACKEND, BACKEND_PAGE, { humanCheck: true }) },
    });
    h.services.jobs.io.search = async () => [BACKEND];
    h.services.jobs.io.show = async () => undefined;
    h.services.jobs.io.limits = { ...h.services.jobs.io.limits, searchRounds: 1 };
    expect((await post(h, `/api/bots/${bot.id}/job/handoff`, { action: "skip" })).statusCode).toBe(409);
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 1 });
    await until(h, bot.id, (p) => p.status === "waiting_for_you");
    await post(h, `/api/bots/${bot.id}/job/handoff`, { action: "skip" });
    const project = await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    expect(project.cards).toEqual([]);
    expect(project.log.map((l) => l.text)).toContain(
      "Skipped jobs.northwind-robotics.example: you skipped it",
    );
  });

  it("says to set up search when the web searches find nothing", async () => {
    h = await jobHarness(jobTeam());
    const { bot } = await readyJobBot(h);
    h.services.jobs.io.limits = { ...h.services.jobs.io.limits, searchRounds: 1 };
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 3 });
    const project = await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    expect(project.scan!.stopReason).toMatch(/set up a search service in Settings → Browser/);
  });

  it("ends a page still loading at the scan's time limit, as the time limit and not a Stop", async () => {
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url) }));
    const { bot } = await readyJobBot(h);
    // A page that never finishes loading until the scan's deadline cuts it off.
    h.services.jobs.io.readers = {
      text: {
        id: "text",
        read: (_url, { signal }) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      },
    };
    h.services.jobs.io.search = async () => [BACKEND];
    h.services.jobs.io.limits = { ...h.services.jobs.io.limits, minutes: 0.005 };
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 1 });
    const project = await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    // Before: the limit was only looked at between pages, so this scan would never have ended.
    expect(project.scan?.stopReason).toBe("Reached the time limit for one scan.");
  });

  it("stops when you press Stop", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url) }));
    const { bot } = await readyJobBot(h);
    serveSite(h);
    h.services.jobs.io.search = async () => {
      await held;
      return [LIST];
    };
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 2 });
    await until(h, bot.id, (p) => p.status === "scanning" && (p.scan?.searchRounds ?? 0) > 0);
    const stopping = post(h, `/api/bots/${bot.id}/job/stop`);
    release();
    await stopping;
    const project = await until(h, bot.id, (p) => p.status === "ready");
    expect(project.scan!.stopReason).toBe("You stopped it.");
    // The closing words are the scan's summary, not a bare "Scan stopped.".
    await until(h, bot.id, () => botSaid(h, bot).at(-1)?.startsWith("Scan stopped.") === true);
  });
});

describe("checking the board's jobs are still open", () => {
  it("reads each Found job again without a model, and marks the ones gone or closed", async () => {
    const team = jobTeam({ check: (url) => siteChecker(url) });
    h = await jobHarness(team);
    const { bot } = await readyJobBot(h);
    serveSite(h);
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 2 });
    await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt);
    const checkerTurns = team.seen.filter((s) => s.role === "checker").length;
    // Since the scan, the backend job's page is gone and the designer job says it has closed.
    serveSite(h, {
      text: {
        [BACKEND]: page(BACKEND, "", { status: 404 }),
        [DESIGNER]: page(DESIGNER, pad("Product Designer. This position has been filled.")),
      },
    });
    const started = await post(h, `/api/bots/${bot.id}/job/check-open`);
    expect(started.statusCode).toBe(200);
    const project = await until(
      h,
      bot.id,
      (p) => p.status === "ready" && p.log.at(-1)!.text.startsWith("Checked"),
    );
    expect(project.log.at(-1)!.text).toBe("Checked 2 jobs: 2 closed (marked on the board).");
    for (const url of [BACKEND, DESIGNER])
      expect(project.cards.find((c) => c.url === url)!.warnings.map((w) => w.id)).toContain("closed");
    // No model was asked.
    expect(team.seen.filter((s) => s.role === "checker").length).toBe(checkerTurns);
    // It can be run again whenever you like; nothing runs it on its own.
    expect((await post(h, `/api/bots/${bot.id}/job/check-open`)).statusCode).toBe(200);
    await until(h, bot.id, (p) => p.status === "ready");
  });

  it("stops when you press Stop, and leaves the last scan as it was", async () => {
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url) }));
    const { bot } = await readyJobBot(h);
    serveSite(h);
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 2 });
    const before = (await until(h, bot.id, (p) => p.status === "ready" && !!p.scan?.endedAt)).scan;
    // A page that never answers until the check is stopped.
    h.services.jobs.io.readers = {
      text: {
        id: "text",
        read: (_url, context) =>
          new Promise((_resolve, reject) =>
            context.signal.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      },
    };
    await post(h, `/api/bots/${bot.id}/job/check-open`);
    await until(h, bot.id, (p) => p.status === "scanning");
    await post(h, `/api/bots/${bot.id}/job/stop`);
    const project = await until(h, bot.id, (p) => p.status === "ready");
    expect(project.log.at(-1)!.text).toBe("Stopped checking.");
    expect(project.scan).toEqual(before);
    expect(project.note).toBeNull();
  });
});

describe("the board", () => {
  it("moves a job on a reaction, and a reason suggests a profile change you can accept", async () => {
    h = await jobHarness(jobTeam({ check: (url) => siteChecker(url) }));
    const { bot } = await readyJobBot(h);
    serveSite(h);
    await post(h, `/api/bots/${bot.id}/job/scan`, { target: 1 });
    const card = (await until(h, bot.id, (p) => p.status === "ready" && p.cards.length === 1)).cards[0]!;
    let res = await post(h, `/api/bots/${bot.id}/job/cards/${card.id}/react`, {
      reaction: "down",
      reason: "weekly on-call",
    });
    const project = res.json().project;
    expect(project.cards[0]).toMatchObject({
      column: "not_for_me",
      reaction: "down",
      reason: "weekly on-call",
    });
    expect(project.suggestions).toMatchObject([{ field: "dealBreakers", value: "weekly on-call" }]);
    res = await post(h, `/api/bots/${bot.id}/job/suggestions/${project.suggestions[0].id}`, { accept: true });
    expect(res.json().project.profile.dealBreakers).toEqual(["weekly on-call"]);
    expect(res.json().project.suggestions).toEqual([]);
    res = await patch(h, `/api/bots/${bot.id}/job/cards/${card.id}`, { column: "applied" });
    expect(res.json().project.cards[0].column).toBe("applied");
  });
});

describe("the team", () => {
  it("can't be broken up, copied or given work outside the Job Bot's chat", async () => {
    h = await jobHarness(jobTeam());
    const { bot, project } = await makeJobBot(h);
    const role = project.roles.checker.botId;
    const del = (id: string) => h.app.inject({ method: "DELETE", url: `/api/bots/${id}`, headers: auth });
    expect((await del(role)).statusCode).toBe(409);
    expect((await post(h, `/api/bots/${bot.id}/duplicate`)).statusCode).toBe(409);
    const pair = h.store.threads.list().find((t) => t.pair && t.memberIds.includes(role))!;
    await post(h, `/api/threads/${pair.id}/messages`, { text: "check this page" });
    expect(h.store.messages.list(pair.id).at(-1)!.parts[0]).toMatchObject({
      text: expect.stringMatching(/^Scout runs its team from its own chat/),
    });
    expect((await del(bot.id)).statusCode).toBeLessThan(300);
    for (const seat of Object.values(project.roles)) expect(h.store.bots.get(seat.botId)).toBeNull();
    expect(h.services.jobs.get(bot.id)).toBeNull();
  });
});
