/**
 * The Job Bot benchmark: fixed, made-up pages and a saved job-system list served
 * instead of the web, read by a real local model. Usage:
 *   pnpm --filter @mrog/harness exec tsx evals/job-bench.eval.ts qwen3.5:9b [--only=title,date] [--tag=before]
 * Each case has its own fresh Job Bot and data, so cases don't affect each other. For each it records whether it
 * passed, the wall time, every model request and the Checker's requests, and a note. Results go to
 * evals/results/job-bench-<model>-<tag>.json; run once before a change and once after, and compare.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PageRead } from "@mrog/jobs";
import { DEFAULT_RUNTIME_SETTINGS, messageText, type JobCard, type JobProject } from "@mrog/shared";
import { openStore } from "@mrog/store";
import { MemoryBackend, Vault } from "@mrog/vault";

import { buildServer, createServices, EventBus, settingsNameIndex, type Services } from "../src/index";
import { apiReader } from "../src/jobs/readers/api";
import type { PageReader } from "../src/jobs/readers/types";

const BOARD = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "greenhouse-gitlab-board.json"), "utf8"),
);

/** Long enough that the reading ladder counts it as a loaded page. */
const pad = (body: string) =>
  `${body}\n\nAbout us\n${"We are a friendly software company with a calm, remote-first team and good benefits. ".repeat(8)}`;

const SITE = "https://careers.brightloop.example";
const page = (url: string, body: string, over: Partial<PageRead> = {}): PageRead => ({
  url,
  title: body.split("\n", 1)[0] ?? "",
  text: body,
  links: [],
  reader: "text",
  humanCheck: false,
  ...over,
});

interface Case {
  name: string;
  items: string;
  profile: Record<string, unknown>;
  target: number;
  /** Pages the text reader serves; the browser reader serves `browser`. */
  text: Record<string, PageRead>;
  browser?: Record<string, PageRead>;
  /** Search results: the same for every query. */
  results: string[];
  check(run: { project: JobProject; cards: JobCard[]; checkerUrls: string[]; read: string[] }): {
    pass: boolean;
    note: string;
  };
  /** Instead of a scan: messages to the Job Bot's chat (the interview). */
  chat?: string[];
}

const title = (card: JobCard) => card.facts.find((f) => f.name === "title")?.value ?? "";

const CASES: Case[] = [
  {
    name: "title",
    items: "1.1",
    profile: { titles: ["Product Manager"], workplace: ["remote"] },
    target: 2,
    text: {
      [`${SITE}/jobs/pmm`]: page(
        `${SITE}/jobs/pmm`,
        pad(
          "Senior Product Marketing Manager\nBrightloop\nRemote (UK)\nYou will write launch messaging, run campaigns and work with sales on positioning.",
        ),
      ),
      [`${SITE}/jobs/pm`]: page(
        `${SITE}/jobs/pm`,
        pad(
          "Product Manager\nBrightloop\nRemote (UK)\nYou will own the roadmap for our billing product and work with engineers.",
        ),
      ),
    },
    results: [`${SITE}/jobs/pmm`, `${SITE}/jobs/pm`],
    check({ cards }) {
      const pmm = cards.find((c) => /Marketing/.test(title(c)));
      const pm = cards.find((c) => /^Product Manager$/.test(title(c)));
      const pmmTitle = pmm?.match.find((l) => l.kind === "title");
      return {
        pass: !!pm && pm.score >= 50 && (!pmm || pmm.score < 50),
        note: `PM ${pm?.score ?? "-"}; PMM ${pmm?.score ?? "-"} (title ${pmmTitle?.verdict ?? "-"})`,
      };
    },
  },
  {
    name: "date",
    items: "1.2",
    profile: { titles: ["Backend Engineer"], workplace: ["remote"] },
    target: 1,
    text: {
      [`${SITE}/jobs/be`]: page(
        `${SITE}/jobs/be`,
        pad("Backend Engineer\nBrightloop\nRemote\nPosted Nov 12\nYou will build APIs in Python and Go."),
      ),
    },
    results: [`${SITE}/jobs/be`],
    check({ cards }) {
      const card = cards[0];
      const old = card?.warnings.find((w) => w.id === "old-posting");
      return { pass: !!card && !old, note: card ? (old ? old.text : "no old-posting warning") : "no card" };
    },
  },
  {
    name: "dealbreaker-cut",
    items: "1.3",
    profile: {
      titles: ["Backend Engineer"],
      relatedTitles: ["Platform Engineer"],
      seniority: "Senior",
      workplace: ["remote"],
      places: ["United Kingdom"],
      rightToWork: "UK citizen",
      // In the order used before 1.3, 20 must-haves came first and this deal-breaker, seventh of seven, was 32nd:
      // past the 30 the Checker is asked about.
      mustHaves: Array.from({ length: 20 }, (_, i) => `Skill ${i + 1}`),
      dealBreakers: [
        ...Array.from({ length: 6 }, (_, i) => `Other deal-breaker ${i + 1}`),
        "Weekly on-call rotation",
      ],
      avoidCompanies: ["Brightloop"],
    },
    target: 1,
    text: {
      [`${SITE}/jobs/oncall`]: page(
        `${SITE}/jobs/oncall`,
        pad(
          "Senior Backend Engineer\nBrightloop\nRemote, United Kingdom\nYou will join our weekly on-call rotation and keep the payments API running.",
        ),
      ),
    },
    results: [`${SITE}/jobs/oncall`],
    check({ cards, project }) {
      const card = cards[0];
      // A company on the avoid list, and a deal-breaker it has: never a good match.
      const ok = !card || card.score <= 10;
      return {
        pass: ok,
        note: card
          ? `score ${card.score}; ${card.warnings.map((w) => w.id).join(",")}`
          : (project.log.at(-2)?.text ?? ""),
      };
    },
  },
  {
    name: "error-page",
    items: "1.4",
    profile: { titles: ["Backend Engineer"], workplace: ["remote"] },
    target: 1,
    text: {
      [`${SITE}/jobs/blocked`]: page(
        `${SITE}/jobs/blocked`,
        `Access denied\n${"You don't have permission to access this page on this server. Reference #18.a2. ".repeat(10)}`,
        { status: 403 },
      ),
    },
    browser: {
      [`${SITE}/jobs/blocked`]: page(
        `${SITE}/jobs/blocked`,
        pad("Backend Engineer\nBrightloop\nRemote\nYou will build APIs in Python."),
      ),
    },
    results: [`${SITE}/jobs/blocked`],
    check({ cards, checkerUrls }) {
      const checks = checkerUrls.filter((u) => u.endsWith("/jobs/blocked")).length;
      return {
        pass: cards.length === 1 && checks === 1,
        note: `Checker turns on it: ${checks}; cards: ${cards.length}`,
      };
    },
  },
  {
    name: "closed-in-list",
    items: "1.7",
    profile: { titles: ["Backend Engineer"], workplace: ["remote"] },
    target: 1,
    text: {
      [`${SITE}/careers`]: page(
        `${SITE}/careers`,
        pad(
          `Open roles at Brightloop\nBackend Engineer (${SITE}/jobs/be2)\nData Analyst (${SITE}/jobs/da) - applications closed\nSupport Engineer (${SITE}/jobs/se)`,
        ),
        {
          links: [
            { text: "Backend Engineer", url: `${SITE}/jobs/be2` },
            { text: "Data Analyst", url: `${SITE}/jobs/da` },
            { text: "Support Engineer", url: `${SITE}/jobs/se` },
          ],
        },
      ),
      [`${SITE}/jobs/be2`]: page(
        `${SITE}/jobs/be2`,
        pad("Backend Engineer\nBrightloop\nRemote\nYou will build APIs in Python."),
      ),
    },
    results: [`${SITE}/careers`],
    check({ cards }) {
      return {
        pass: cards.some((c) => /Backend/.test(title(c))),
        note: `cards: ${cards.map(title).join("; ") || "none"}`,
      };
    },
  },
  {
    name: "greenhouse-list",
    items: "2.1",
    profile: { titles: ["Backend Engineer"], workplace: ["remote"] },
    target: 3,
    text: {},
    results: ["https://job-boards.greenhouse.io/gitlab"],
    check({ read, checkerUrls }) {
      const postings = read.filter((u) => /\/jobs\/\d+/.test(u));
      const backend = BOARD.jobs.filter((j: { title: string }) => /backend engineer/i.test(j.title)).length;
      const listChecks = checkerUrls.filter((u) => u.endsWith("/gitlab")).length;
      return {
        pass: postings.length >= 3,
        note: `postings read: ${postings.length} (board has ${backend} backend jobs); Checker turns on the list: ${listChecks}`,
      };
    },
  },
  {
    name: "interview",
    items: "4.1, 4.3",
    profile: {},
    target: 1,
    text: {},
    results: [],
    chat: [
      "I want Product Manager jobs, remote, in London. Must have: SQL.",
      "Also add a must-have: experience with B2B SaaS.",
    ],
    check({ project }) {
      const p = project.profile;
      const sql = p.mustHaves.some((m) => /sql/i.test(m));
      const saas = p.mustHaves.some((m) => /saas/i.test(m));
      return {
        pass: p.titles.length > 0 && sql && saas,
        note: `titles=${JSON.stringify(p.titles)} mustHaves=${JSON.stringify(p.mustHaves)}`,
      };
    },
  },
];

const savedReader = (
  id: "text" | "browser",
  pages: Record<string, PageRead>,
  read: string[],
): PageReader => ({
  id,
  async read(url) {
    read.push(url);
    const found = pages[url];
    if (!found) throw new Error(`no saved page for ${url}`);
    return { ...found, reader: id };
  },
});

/** The saved board for the Greenhouse API; a posting's own address answers 404 (no saved posting). */
const savedApiFetch = (read: string[]) =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    read.push(url);
    if (url.endsWith("/boards/gitlab/jobs")) return Response.json({ jobs: BOARD.jobs });
    return new Response("not saved", { status: 404 });
  }) as typeof fetch;

async function runCase(model: string, test: Case) {
  const dataDir = mkdtempSync(join(tmpdir(), "mrog-jobbench-"));
  const counts = { requests: 0, checker: 0 };
  const checkerUrls: string[] = [];
  const read: string[] = [];
  const realFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/api/chat") && typeof init?.body === "string") {
      counts.requests += 1;
      const body = JSON.parse(init.body) as { messages?: { role: string; content?: string }[] };
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("You are the Checker of a Job Bot")) {
        const task = body.messages?.find((m) => m.role === "user")?.content ?? "";
        const address = /^ADDRESS: (.+)$/m.exec(task)?.[1];
        // Only a fresh Checker turn: its later steps carry the same task.
        if (address && body.messages!.filter((m) => m.role === "tool").length === 0) {
          counts.checker += 1;
          checkerUrls.push(address);
        }
      }
    }
    return fetch(input, init);
  }) as typeof fetch;
  const store = openStore(":memory:");
  const bus = new EventBus();
  const vault = new Vault(new MemoryBackend(), settingsNameIndex(store.settings));
  const services: Services = createServices({
    config: {
      host: "127.0.0.1",
      port: 0,
      token: "eval",
      dataDir,
      uiOrigins: [],
      uiDist: null,
      heartbeatMs: 60_000,
      vault: "memory",
      keyringService: "eval",
      previousKeyringService: null,
      eventLog: false,
    },
    store,
    vault,
    bus,
    fetchImpl: realFetch,
  });
  store.settings.set("runtime", {
    ...DEFAULT_RUNTIME_SETTINGS,
    sharedModel: `ollama:${model}`,
    numCtx: 16384,
  });
  const app = await buildServer(services);
  const jobs = services.jobs;
  jobs.io.readers = {
    api: apiReader(savedApiFetch(read)),
    text: savedReader("text", test.text, read),
    browser: savedReader("browser", test.browser ?? {}, read),
  };
  jobs.io.search = async () => test.results;
  const { bot } = await jobs.create({ name: "Scout" });
  const started = Date.now();
  let result: { pass: boolean; note: string };
  try {
    if (test.chat) {
      const thread = store.threads.get(bot.threadId)!;
      for (const text of test.chat) {
        const before = store.messages.list(thread.id).length;
        await services.turns.send(thread, { text });
        // The interview's reply is the Job Bot's status message, closed when the Interviewer is done.
        for (let waited = 0; waited < 600_000; waited += 250) {
          const after = store.messages.list(thread.id).slice(before);
          if (
            after.some(
              (m) =>
                m.role === "bot" &&
                m.status !== "streaming" &&
                messageText(m).length > 0 &&
                m.botId === bot.id &&
                !messageText(m).startsWith("One moment"),
            )
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    } else {
      jobs.updateProfile(bot.id, test.profile as never);
      jobs.approveProfile(bot.id);
      jobs.startScan(bot.id, test.target);
      await jobs.idle(bot.id);
    }
    const project = jobs.get(bot.id)!;
    result = test.check({ project, cards: project.cards, checkerUrls, read });
  } catch (error) {
    result = { pass: false, note: `failed: ${(error as Error).message}` };
  }
  const project = jobs.get(bot.id);
  await app.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  return {
    case: test.name,
    items: test.items,
    ...result,
    seconds: Math.round((Date.now() - started) / 1000),
    ...counts,
    stopReason: project?.scan?.stopReason ?? null,
  };
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const only = args
  .find((arg) => arg.startsWith("--only="))
  ?.slice(7)
  .split(",");
const tag = args.find((arg) => arg.startsWith("--tag="))?.slice(6) ?? "run";
const models = args.filter((arg) => !arg.startsWith("--"));
if (models.length === 0) {
  console.error(
    "Name at least one Ollama model. --only=title,date picks cases; --tag=before names the results file.",
  );
  process.exit(1);
}
const dir = join(import.meta.dirname, "results");
mkdirSync(dir, { recursive: true });
for (const model of models) {
  const results = [];
  for (const test of CASES.filter((c) => !only || only.includes(c.name))) {
    const result = await runCase(model, test);
    results.push(result);
    console.log(
      `${result.pass ? "PASS" : "FAIL"} ${result.case} (${result.items}) ${result.seconds}s requests=${result.requests} checker=${result.checker} | ${result.note}${result.stopReason ? ` | ${result.stopReason}` : ""}`,
    );
    writeFileSync(
      join(dir, `job-bench-${model.replace(/[^\w.-]+/g, "_")}-${tag}.json`),
      JSON.stringify({ model, tag, at: new Date().toISOString(), results }, null, 2),
    );
  }
}
process.exit(0);
