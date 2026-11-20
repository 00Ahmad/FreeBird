/**
 * The Client Bot benchmark: fixed, made-up pages, saved register answers and
 * search results served instead of the web, read by a real local model. Usage:
 *   pnpm --filter @mrog/harness exec tsx evals/client-bench.eval.ts qwen3.5:9b [--only=menu,footer] [--tag=before]
 * Each case has its own fresh Client Bot and data. Several are pages that must NOT become leads (a restaurant menu, a
 * competitor, a "top 10 providers" list, a footer, a charity fundraiser, a news site), so a wrong lead shows up as a
 * failure. For each it records whether it passed, the wall time, every model request and the Checker's requests (and
 * on which pages), and a note. Results go to evals/results/client-bench-<model>-<tag>.json.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { playbookOf, type RegisterRequest } from "@mrog/clients";
import type { PageRead } from "@mrog/jobs";
import {
  DEFAULT_RUNTIME_SETTINGS,
  messageText,
  type ClientProject,
  type Lead,
  type LeadKind,
} from "@mrog/shared";
import { openStore } from "@mrog/store";
import { MemoryBackend, Vault } from "@mrog/vault";

import { KEY_NAMES } from "../src/clients/registers";
import { buildServer, createServices, EventBus, settingsNameIndex, type Services } from "../src/index";
import type { PageReader } from "../src/jobs/readers/types";

/** Long enough that the reading ladder counts it as a loaded page. */
const pad = (body: string) =>
  `${body}\n\n${"We are a friendly local business in Leeds and we love looking after our customers every day. ".repeat(7)}`;

const page = (url: string, body: string, over: Partial<PageRead> = {}): PageRead => ({
  url,
  title: body.split("\n", 1)[0] ?? "",
  text: body,
  links: [],
  reader: "text",
  humanCheck: false,
  ...over,
});

const PAYROLL = {
  offer: "Outsourced payroll for restaurants",
  areas: ["Leeds"],
  industries: ["restaurants"],
  sizeMin: 5,
  sizeMax: 100,
};

interface Case {
  name: string;
  items: string;
  profile: Record<string, unknown>;
  target: number;
  kinds: LeadKind[];
  /** Pages the text reader serves. */
  text: Record<string, PageRead>;
  /** Search results for a query (the same function answers the scan's searches and the own-site look-ups). */
  results(query: string): string[];
  /** Register answers by request address; unknown ones answer nothing. */
  registers?: (request: RegisterRequest) => unknown;
  /** A Companies House key is saved. */
  key?: boolean;
  check(run: { project: ClientProject; leads: Lead[]; checkerUrls: string[]; read: string[] }): {
    pass: boolean;
    note: string;
  };
  /** Instead of a scan: messages to the Client Bot's chat (the interview). */
  chat?: string[];
}

const leadLine = (lead: Lead) =>
  `${lead.company} [${lead.kind} ${lead.score}] signs=${lead.signals.map((s) => s.kind).join(",") || "-"} domain=${lead.domain ?? "-"}`;
const leadsNote = (leads: Lead[]) => (leads.length > 0 ? leads.map(leadLine).join("; ") : "no leads");

const MENU = "https://emberandoak.test/";
const RIVAL = "https://payroll-pals.test/";
const TOP = "https://leedsbiz.test/best-payroll-providers-leeds";
const JUNIPER = "https://junipercafe.test/";
const CHARITY = "https://thebluedoorbistro.test/news";
const LIVE_NEWS = "https://www.leeds-live.test/news/leeds-kitchen-co-hiring";
const LIVE_INDEX = "https://www.leeds-live.test/news";
const LKC = "https://leedskitchenco.test/";
const NEWS = "https://yorkshirefood.test/news/brightside-hiring";
const SITE = "https://brightside-kitchens.test/";

const navLinks = (base: string) =>
  ["About", "Menu", "Contact us"].map((label) => ({
    text: label,
    url: `${base}${label.toLowerCase().replace(/ /g, "-")}`,
  }));

const CASES: Case[] = [
  {
    name: "menu",
    items: "1.1",
    profile: PAYROLL,
    target: 1,
    kinds: ["asking", "signs"],
    text: {
      [MENU]: page(
        MENU,
        pad(
          "Ember & Oak\nA restaurant in Leeds.\nTonight's menu: slow cooked tender beef with roast potatoes.\nWe recommend booking early for weekends.\nCall Tel: 0113 496 0101 or email bookings@emberandoak.test",
        ),
        { links: navLinks(MENU) },
      ),
    },
    results: () => [MENU],
    check({ leads }) {
      const wrong = leads.filter((l) => l.signals.length > 0);
      return { pass: wrong.length === 0, note: leadsNote(leads) };
    },
  },
  {
    name: "competitor",
    items: "2.6",
    profile: PAYROLL,
    target: 1,
    kinds: ["asking", "signs"],
    text: {
      [RIVAL]: page(
        RIVAL,
        pad(
          "Payroll Pals\nWe offer payroll services to restaurants across Leeds. Our payroll bureau runs your payslips and PAYE.\nEmail hello@payroll-pals.test",
        ),
      ),
    },
    results: () => [RIVAL],
    check({ leads }) {
      return { pass: leads.length === 0, note: leadsNote(leads) };
    },
  },
  {
    name: "top-list",
    items: "2.4",
    profile: PAYROLL,
    target: 1,
    kinds: ["asking", "signs"],
    text: {
      [TOP]: page(
        TOP,
        pad(
          "The 10 best payroll providers in Leeds for 2026\n1. Payroll Pals\n2. Leeds Payroll Bureau\n3. Pennine Pay Services",
        ),
      ),
    },
    // The address alone doesn't give it away on purpose: "/guides/payroll" would; this one is caught from the page.
    results: () => [TOP.replace("best-payroll-providers-leeds", "guides/leeds-roundup")],
    check({ leads, checkerUrls }) {
      const turns = checkerUrls.filter((u) => u.includes("leeds-roundup")).length;
      return { pass: leads.length === 0, note: `${leadsNote(leads)}; Checker turns on the list: ${turns}` };
    },
  },
  {
    name: "footer",
    items: "1.3, 1.6",
    profile: PAYROLL,
    target: 1,
    kinds: ["asking", "signs"],
    text: {
      [JUNIPER]: page(
        JUNIPER,
        pad(
          "Juniper Cafe\nTwo cafes in Leeds with a team of 14 staff. We are hiring a Payroll Administrator (posted 2 November 2026).\nOur services include catering for events.\nSite by Pixel Agency hello@pixelagency.test",
        ),
        { links: navLinks(JUNIPER) },
      ),
    },
    results: () => [JUNIPER],
    check({ leads }) {
      const fieldName = leads.filter((l) =>
        /^(services|email|phone|address|contact|location)$/i.test(l.company),
      );
      const agency = leads.filter((l) => l.contacts.some((c) => /pixelagency/.test(c.value)));
      return {
        pass: fieldName.length === 0 && agency.length === 0,
        note: `${leadsNote(leads)}; contacts=${leads.flatMap((l) => l.contacts.map((c) => c.value)).join(",") || "-"}`,
      };
    },
  },
  {
    name: "charity",
    items: "1.1, 1.2",
    profile: PAYROLL,
    target: 1,
    kinds: ["asking", "signs"],
    text: {
      [CHARITY]: page(
        CHARITY,
        pad(
          "The Blue Door Bistro news\nWe raised £500 for the local hospice at our summer quiz night.\nEstablished in 1987, family run.\nRegistered in England and Wales No. 01234567.\nEmail info@thebluedoorbistro.test",
        ),
      ),
    },
    results: () => [CHARITY],
    check({ leads }) {
      const wrong = leads.filter((l) =>
        l.signals.some((s) => s.kind === "funding" || s.kind === "new_company"),
      );
      return { pass: wrong.length === 0, note: leadsNote(leads) };
    },
  },
  {
    name: "news-site",
    items: "1.4",
    profile: PAYROLL,
    target: 1,
    kinds: ["asking", "signs"],
    text: {
      [LIVE_NEWS]: page(
        LIVE_NEWS,
        pad(
          "Leeds Kitchen Co is hiring\nPublished 4 November 2026\nLeeds restaurant Leeds Kitchen Co is advertising for a Payroll Administrator as it grows to 40 staff.",
        ),
      ),
      [LIVE_INDEX]: page(
        LIVE_INDEX,
        pad(
          "Leeds Live news\nThe latest news from Leeds: business, sport and what's on. Leeds Live is the city's news site, read by thousands of people.",
        ),
      ),
      [LKC]: page(
        LKC,
        pad(
          "Leeds Kitchen Co\nA restaurant in Leeds with a team of 40.\nEmail hello@leedskitchenco.test or call Tel: 0113 496 0202",
        ),
        { links: navLinks(LKC) },
      ),
    },
    // The news site comes first in the look-up for the company's own site: its address shares the word "leeds".
    results: (q) => (/"Leeds Kitchen Co"/i.test(q) ? [LIVE_INDEX, LKC] : [LIVE_NEWS]),
    check({ leads }) {
      const wrong = leads.filter((l) => l.domain === "leeds-live.test");
      return { pass: wrong.length === 0, note: leadsNote(leads) };
    },
  },
  {
    name: "good-hiring",
    items: "sanity",
    profile: PAYROLL,
    target: 1,
    kinds: ["asking", "signs"],
    text: {
      [NEWS]: page(
        NEWS,
        pad(
          "Brightside Kitchens is hiring\nPublished 3 November 2026\nLeeds restaurant group Brightside Kitchens is advertising for a Payroll Administrator to join its team.",
        ),
      ),
      [SITE]: page(
        SITE,
        pad(
          "Brightside Kitchens\nA family restaurant group in Leeds. Our team of 30 serves three restaurants.\nSay hello@brightside-kitchens.test or call Tel: 0113 496 0000.",
        ),
        { links: navLinks(SITE) },
      ),
    },
    results: (q) => (/"Brightside Kitchens"/i.test(q) ? [SITE] : [NEWS]),
    check({ leads }) {
      const lead = leads.find((l) => /brightside/i.test(l.company));
      return {
        pass: !!lead && lead.score >= 50 && lead.domain === "brightside-kitchens.test",
        note: leadsNote(leads),
      };
    },
  },
  {
    name: "wrong-record",
    items: "1.4",
    profile: PAYROLL,
    target: 1,
    kinds: ["signs"],
    key: true,
    text: {
      [SITE]: page(
        SITE,
        pad(
          "Brightside Kitchens\nA family restaurant group in Leeds. Our team of 30 serves three restaurants. We are hiring a Payroll Administrator, posted 5 November 2026.\nSay hello@brightside-kitchens.test or call Tel: 0113 496 0000.",
        ),
        { links: navLinks(SITE) },
      ),
    },
    results: () => [SITE],
    registers(request) {
      // The name search finds another Brightside first, then the right one.
      if (request.url.includes("/search/companies"))
        return {
          items: [
            { company_number: "11111111", title: "BRIGHTSIDE CLEANING LTD" },
            { company_number: "22222222", title: "BRIGHTSIDE KITCHENS LTD" },
          ],
        };
      if (request.url.endsWith("/company/11111111"))
        return {
          company_name: "BRIGHTSIDE CLEANING LTD",
          company_number: "11111111",
          company_status: "dissolved",
          sic_codes: ["81210"],
          registered_office_address: { locality: "Bradford" },
        };
      if (request.url.endsWith("/company/22222222"))
        return {
          company_name: "BRIGHTSIDE KITCHENS LTD",
          company_number: "22222222",
          company_status: "active",
          sic_codes: ["56101"],
          registered_office_address: { locality: "Leeds" },
        };
      return null;
    },
    check({ leads }) {
      const lead = leads.find((l) => /brightside/i.test(l.company));
      const records = lead?.records.map((r) => `${r.id}:${r.status}`).join(",") ?? "-";
      return {
        pass: !!lead && !lead.records.some((r) => r.id === "11111111"),
        note: `${leadsNote(leads)}; records=${records}`,
      };
    },
  },
  {
    name: "tender",
    items: "sanity",
    profile: PAYROLL,
    target: 1,
    kinds: ["asking"],
    text: {},
    results: () => [],
    registers(request) {
      if (!request.url.includes("contractsfinder")) return null;
      const keyword = (JSON.parse(request.body ?? "{}") as { searchCriteria?: { keyword?: string } })
        .searchCriteria?.keyword;
      if (keyword !== "payroll") return { noticeList: [] };
      return {
        noticeList: [
          {
            item: {
              id: "aaaa-1111",
              title: "Provision of payroll services",
              description: "Leeds City Council seeks a provider of payroll services for 300 school staff.",
              organisationName: "Leeds City Council",
              publishedDate: "2026-11-02T00:00:00Z",
              deadlineDate: "2026-12-15T00:00:00Z",
              regionText: "Yorkshire and the Humber",
            },
          },
          {
            item: {
              id: "bbbb-2222",
              title: "Grounds maintenance",
              description: "Grass cutting and hedge trimming for parks.",
              organisationName: "Wakefield Council",
              publishedDate: "2026-11-01T00:00:00Z",
              deadlineDate: "2026-12-01T00:00:00Z",
            },
          },
        ],
      };
    },
    check({ leads }) {
      const right = leads.filter((l) => /leeds city council/i.test(l.company) && l.kind === "asking");
      const wrong = leads.filter((l) => /wakefield/i.test(l.company));
      return { pass: right.length === 1 && wrong.length === 0, note: leadsNote(leads) };
    },
  },
  {
    name: "interview",
    items: "1.7, 4.2, 4.4",
    profile: {},
    target: 1,
    kinds: ["signs"],
    text: {},
    results: () => [],
    chat: [
      "I sell IT support for accountants in Leeds. Ideal clients have 10 to 50 staff.",
      "Also add law firms as an industry.",
    ],
    check({ project }) {
      const p = project.profile;
      const kind = playbookOf(p).id;
      const accountants = p.industries.some((i) => /account/i.test(i));
      const law = p.industries.some((i) => /law/i.test(i));
      return {
        pass: kind === "it_support" && accountants && law,
        note: `playbook=${kind} industries=${JSON.stringify(p.industries)} areas=${JSON.stringify(p.areas)}`,
      };
    },
  },
];

const savedReader = (pages: Record<string, PageRead>, read: string[]): PageReader => ({
  id: "text",
  async read(url) {
    read.push(url);
    const found = pages[url];
    if (!found) throw new Error(`no saved page for ${url}`);
    return { ...found, reader: "text" };
  },
});

async function runCase(model: string, test: Case) {
  const dataDir = mkdtempSync(join(tmpdir(), "mrog-clientbench-"));
  const counts = { requests: 0, checker: 0 };
  const checkerUrls: string[] = [];
  const read: string[] = [];
  /** What each Checker turn reported (its finish_page arguments), to see why a page gave nothing. */
  const reports: { address: string; args: unknown }[] = [];
  const realFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    let checking: string | null = null;
    if (url.endsWith("/api/chat") && typeof init?.body === "string") {
      counts.requests += 1;
      const body = JSON.parse(init.body) as { messages?: { role: string; content?: string }[] };
      const system = body.messages?.[0]?.content ?? "";
      if (system.includes("You are the Checker of a Client Bot")) {
        const task = body.messages?.find((m) => m.role === "user")?.content ?? "";
        const address = /^ADDRESS: (.+)$/m.exec(task)?.[1];
        checking = address ?? null;
        if (address && body.messages!.filter((m) => m.role === "tool").length === 0) {
          counts.checker += 1;
          checkerUrls.push(address);
        }
      }
    }
    const res = await fetch(input, init);
    if (checking) {
      const address = checking;
      void res
        .clone()
        .text()
        .then((text) => {
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try {
              const calls = (
                JSON.parse(line) as { message?: { tool_calls?: { function: { arguments: unknown } }[] } }
              ).message?.tool_calls;
              for (const call of calls ?? []) reports.push({ address, args: call.function.arguments });
            } catch {
              // Not a JSON line.
            }
          }
        })
        .catch(() => undefined);
    }
    return res;
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
  const clients = services.clients;
  if (test.key) vault.set(KEY_NAMES.companiesHouse, "bench-key");
  clients.io.readers = { text: savedReader(test.text, read) };
  clients.io.search = async (_botId, query) => test.results(query);
  clients.io.fetch = async (request) => test.registers?.(request) ?? null;
  const { bot } = await clients.create({ name: "Finder" });
  const started = Date.now();
  let result: { pass: boolean; note: string };
  try {
    if (test.chat) {
      const thread = store.threads.get(bot.threadId)!;
      for (const text of test.chat) {
        const before = store.messages.list(thread.id).length;
        await services.turns.send(thread, { text });
        for (let waited = 0; waited < 600_000; waited += 250) {
          const after = store.messages.list(thread.id).slice(before);
          if (
            after.some(
              (m) =>
                m.role === "bot" &&
                m.status !== "streaming" &&
                m.botId === bot.id &&
                messageText(m).length > 0 &&
                !messageText(m).startsWith("One moment"),
            )
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    } else {
      clients.updateProfile(bot.id, test.profile as never);
      clients.approveProfile(bot.id);
      clients.startScan(bot.id, test.target, test.kinds);
      await clients.idle(bot.id);
    }
    const project = clients.get(bot.id)!;
    result = test.check({ project, leads: project.leads, checkerUrls, read });
  } catch (error) {
    result = { pass: false, note: `failed: ${(error as Error).message}` };
  }
  const project = clients.get(bot.id);
  await app.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  return {
    case: test.name,
    items: test.items,
    ...result,
    seconds: Math.round((Date.now() - started) / 1000),
    ...counts,
    checkerPages: checkerUrls,
    stopReason: project?.scan?.stopReason ?? null,
    // The activity list and the Checker's reports, to see why a case failed.
    log: project?.log.slice(-15).map((l) => l.text) ?? [],
    reports,
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
    "Name at least one Ollama model. --only=menu,footer picks cases; --tag=before names the results file.",
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
      join(dir, `client-bench-${model.replace(/[^\w.-]+/g, "_")}-${tag}.json`),
      JSON.stringify({ model, tag, at: new Date().toISOString(), results }, null, 2),
    );
  }
}
process.exit(0);
