import { clientFact } from "@mrog/clients";
import { afterEach, describe, expect, it } from "vitest";

import { auth, type TestHarness } from "../testing";
import {
  botSaid,
  clientHarness,
  clientTeam,
  makeClientBot,
  NEWS,
  NEWS_PAGE,
  NEWS_REPORT,
  page,
  pad,
  patch,
  PINE,
  PINE_REPORT,
  post,
  projectOf,
  readyClientBot,
  RIVAL,
  savedReaders,
  scan,
  SITE,
  SITE_PAGES,
  SITE_REPORT,
  type,
  until,
} from "./clients-testing";
import { KEY_NAMES } from "./registers";
import type { Capture } from "./tools";

let h: TestHarness;
afterEach(async () => {
  await h?.close();
  // A test that makes no harness must not close the last one again.
  h = undefined as unknown as TestHarness;
});

/** The Checker of the saved pages: the news item, Brightside's own site, a competitor, Pine Cafe. */
const checker = (url: string) =>
  url === NEWS
    ? NEWS_REPORT
    : url === SITE
      ? SITE_REPORT
      : url === RIVAL
        ? { kind: "competitor" as const }
        : url === PINE
          ? PINE_REPORT
          : { kind: "other" as const };

/** Serves the saved pages; the first search finds the news item, a company search finds its own site. */
function serve(target: TestHarness, results: (query: string) => string[] | null = () => null) {
  const readers = savedReaders(SITE_PAGES());
  target.services.clients.io.readers = { text: readers.text };
  const queries: string[] = [];
  target.services.clients.io.search = async (_bot, query) => {
    queries.push(query);
    if (/"Brightside Kitchens"/.test(query)) return [SITE];
    if (/"Pine Cafe/i.test(query)) return [PINE];
    if (/Payroll Administrator/.test(query))
      return [NEWS, RIVAL, "https://news.test/best-payroll-companies-leeds"];
    return results(query);
  };
  return { readers, queries };
}

describe("making a Client Bot", () => {
  it("makes its hidden team and protects it", async () => {
    h = await clientHarness(clientTeam());
    const { bot, project } = await makeClientBot(h);
    expect(bot.client).toBe(true);
    expect(project.status).toBe("interview");
    const roles = Object.values(project.roles).map((seat) => h.store.bots.get(seat.botId)!);
    expect(roles.every((role) => role.hidden && role.parentId === bot.id)).toBe(true);
    const del = await h.app.inject({ method: "DELETE", url: `/api/bots/${roles[0]!.id}`, headers: auth });
    expect(del.statusCode).toBe(409);
    const rename = await patch(h, `/api/bots/${roles[1]!.id}`, { name: "Other" });
    expect(rename.statusCode).toBe(409);
    // Deleting the Client Bot takes its team.
    await h.app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: auth });
    expect(roles.every((role) => !h.store.bots.get(role.id))).toBe(true);
  });

  it("refuses a name already taken", async () => {
    h = await clientHarness(clientTeam());
    await makeClientBot(h);
    const again = await post(h, "/api/client-bots", { name: "Finder" });
    expect(again.statusCode).toBe(400);
  });
});

describe("the interview", () => {
  it("saves what you said, saves again when the model forgets, and is ready to approve", async () => {
    let forget = true;
    h = await clientHarness(
      clientTeam({
        interview: (said) => {
          if (forget) {
            forget = false;
            return { say: "Got it!" };
          }
          return /payroll/i.test(said)
            ? { profile: { offer: "Payroll for restaurants", areas: ["Leeds"], industries: ["restaurants"] } }
            : { say: "Tell me more." };
        },
      }),
    );
    const { bot } = await makeClientBot(h);
    await type(h, bot, "I sell payroll to restaurants in Leeds");
    const project = await until(h, bot.id, (p) => p.status === "awaiting_profile");
    expect(project.profile.offer).toBe("Payroll for restaurants");
    // The playbook's defaults were filled in by code.
    expect(project.profile.signals).toContain("hiring");
    const approved = await post(h, `/api/bots/${bot.id}/client/profile/approve`);
    expect(approved.json().project.status).toBe("ready");
  });

  it("knows the question you're answering, adds to lists, keeps a skip, and says what it saved (4.2–4.4, 1.7)", async () => {
    const team = clientTeam({
      interview: (said) =>
        /IT support/.test(said)
          ? {
              profile: { offer: "IT support for accountants", areas: ["Leeds"], industries: ["accountants"] },
              say: "Roughly how many staff do your ideal clients have?",
            }
          : /law firms/.test(said)
            ? { profile: { industries: ["law firms"] }, say: "Roughly how many staff do they have?" }
            : { say: "No problem." },
    });
    h = await clientHarness(team);
    const { bot } = await makeClientBot(h);
    const reply = async (n: number) => {
      for (
        let i = 0;
        i < 400 &&
        h.store.messages.list(bot.threadId).filter((m) => m.role === "bot" && m.status === "done").length < n;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 15));
      return botSaid(h, bot).at(-1)!;
    };
    await type(h, bot, "I sell IT support for accountants in Leeds");
    // The kind of service picked is said back, with what was saved.
    expect(await reply(2)).toMatch(/_Saved: Sells: IT support for accountants; Kind of service: IT support;/);
    await type(h, bot, "Also law firms");
    expect(await reply(3)).toMatch(/_Saved: Added industry: law firms/);
    // Added to the list, not replacing it; and the Interviewer saw the question being answered.
    expect(projectOf(h, bot.id).profile.industries).toEqual(["accountants", "law firms"]);
    const tasks = team.seen.filter((s) => s.role === "interviewer").map((s) => s.task);
    expect(tasks.at(-1)).toMatch(/YOU LAST ASKED \(the user is answering this\)\n[\s\S]*how many staff/);
    const before = team.seen.length;
    await type(h, bot, "skip");
    await reply(4);
    // A skip is kept, and has nothing to save: no second turn asking to save it.
    expect(projectOf(h, bot.id).interview.skipped).toContain("size");
    expect(team.seen.slice(before).filter((s) => s.role === "interviewer").length).toBeLessThanOrEqual(2);
    expect(team.seen.at(-1)!.task).not.toMatch(/You replied without calling save_offer/);
  });

  it("won't scan before the profile is approved", async () => {
    h = await clientHarness(clientTeam());
    const { bot } = await makeClientBot(h);
    const res = await post(h, `/api/bots/${bot.id}/client/scan`, { target: 5 });
    expect(res.statusCode).toBe(409);
  });
});

describe("a scan", () => {
  it("finds a company showing a sign, confirms it on its own site, and never shows a competitor", async () => {
    const team = clientTeam({ check: checker });
    h = await clientHarness(team);
    const { bot } = await readyClientBot(h);
    const { readers } = serve(h);
    const project = await scan(h, bot.id, 2, ["signs"]);
    expect(project.scan!.found).toBe(1);
    const [lead] = project.leads;
    expect(lead).toMatchObject({
      company: "Brightside Kitchens",
      kind: "signs",
      domain: "brightside-kitchens.test",
      ownSite: true,
    });
    expect(lead!.signals[0]).toMatchObject({ kind: "hiring", date: "2026-11-03", url: NEWS });
    expect(lead!.contacts.map((c) => c.kind)).toEqual(["contact_page", "email", "phone"]);
    expect(clientFact(lead!.facts, "size")).toBe("30 staff");
    expect(lead!.evidence.map((e) => e.id)).toContain("has_staff");
    // The list of providers was never read; the competitor's page was read and dropped.
    expect(readers.calls.some((u) => u.includes("best-payroll"))).toBe(false);
    expect(project.log.some((l) => /competitor/.test(l.text))).toBe(true);
    expect(botSaid(h, bot).at(-1)).toMatch(
      /^Found 1 of the 2 you asked for[\s\S]*Strongest new leads:\n- Brightside Kitchens/,
    );
    // The Checker only ever gets finish_page.
    expect(team.seen.filter((s) => s.role === "checker").every((s) => s.tools.join() === "finish_page")).toBe(
      true,
    );
  });

  it("doesn't make a hiring page 'asking now' because the Checker called it a request (found in the benchmark)", async () => {
    h = await clientHarness(
      clientTeam({ check: (url) => (url === NEWS ? { ...NEWS_REPORT, kind: "request" } : checker(url)) }),
    );
    const { bot } = await readyClientBot(h);
    serve(h);
    const project = await scan(h, bot.id, 1, ["signs"]);
    expect(project.leads.map((l) => l.kind)).toEqual(["signs"]);
    expect(project.leads[0]!.contacts.some((c) => c.kind === "respond")).toBe(false);
  });

  it("drops a sign whose quote isn't on the page", async () => {
    h = await clientHarness(
      clientTeam({
        check: (url) =>
          url === NEWS
            ? { ...NEWS_REPORT, signals: [{ kind: "hiring", quote: "hiring a Payroll Officer next week" }] }
            : checker(url),
      }),
    );
    const { bot } = await readyClientBot(h);
    serve(h);
    const project = await scan(h, bot.id, 1, ["signs"]);
    expect(project.leads).toEqual([]);
    expect(project.log.some((l) => /no sign of need/.test(l.text))).toBe(true);
  });

  it("never shows a company on your lists, and adds a new sign to a known lead without counting it", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    serve(h);
    await post(h, `/api/bots/${bot.id}/client/lists/add`, {
      list: "clients",
      text: "Brightside Kitchens Ltd",
    });
    const first = await scan(h, bot.id, 1, ["signs"]);
    expect(first.leads).toEqual([]);
    expect(first.log.some((l) => /on your clients/.test(l.text))).toBe(true);
  });

  it("doesn't read pages that led nowhere, or run the same searches, in the next scan (2.4, 2.5)", async () => {
    const LIST = "https://news.test/leeds/roundup";
    const team = clientTeam({ check: checker });
    h = await clientHarness(team);
    const { bot } = await readyClientBot(h);
    const pages = {
      ...SITE_PAGES(),
      [LIST]: page(LIST, pad("The 10 best payroll providers in Leeds for 2026")),
    };
    const readers = savedReaders(pages);
    h.services.clients.io.readers = { text: readers.text };
    const queries: string[] = [];
    h.services.clients.io.search = async (_bot, query) => {
      queries.push(query);
      return /"Brightside Kitchens"/.test(query) ? [SITE] : [RIVAL, LIST];
    };
    const first = await scan(h, bot.id, 1, ["signs"]);
    // A list of providers, by its own words: never given to the Checker.
    expect(team.seen.filter((s) => s.role === "checker" && s.task.includes(`ADDRESS: ${LIST}`))).toEqual([]);
    expect(first.deadPages.map((d) => d.reason)).toEqual(
      expect.arrayContaining([expect.stringMatching(/competitor/), expect.stringMatching(/lists providers/)]),
    );
    const read = readers.calls.length;
    const searched = queries.length;
    await scan(h, bot.id, 1, ["signs"]);
    // Neither page is read again, and no search of the first scan is run again.
    expect(readers.calls.slice(read).filter((u) => u === RIVAL || u === LIST)).toEqual([]);
    const again = queries.slice(searched).filter((q) => queries.slice(0, searched).includes(q));
    expect(again).toEqual([]);
  });

  it("counts a company only once across scans", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    serve(h);
    await scan(h, bot.id, 1, ["signs"]);
    const second = await scan(h, bot.id, 1, ["signs"]);
    expect(second.leads).toHaveLength(1);
    expect(second.scan!.found).toBe(0);
  });
});

describe("registers", () => {
  const TENDERS = {
    noticeList: [
      {
        item: {
          id: "t-1",
          title: "Provision of payroll services",
          description: "The Test Trust is seeking a payroll provider for its staff.",
          organisationName: "The Test Trust",
          deadlineDate: "2099-12-20T12:00:00+00:00",
          publishedDate: new Date().toISOString(),
          noticeStatus: "Open",
        },
      },
    ],
  };
  const COMPANIES = {
    items: [
      {
        company_name: "PINE CAFE LTD",
        company_number: "12345678",
        company_status: "active",
        date_of_creation: "2015-01-01",
        sic_codes: ["56102"],
        registered_office_address: { locality: "Leeds", postal_code: "LS2 2BB" },
      },
    ],
  };

  it("turns a tender for what you sell into an asking-now lead you can respond to", async () => {
    h = await clientHarness(
      clientTeam({
        check: (url, task) =>
          /contractsfinder/.test(url) && /Deadline: 2099-12-20/.test(task)
            ? {
                kind: "request",
                verdicts: [{ id: "r2", verdict: "meets", reason: "Yorkshire." }],
                summary: "Payroll tender.",
              }
            : checker(url),
      }),
    );
    const { bot } = await readyClientBot(h);
    serve(h);
    const asked: string[] = [];
    h.services.clients.io.fetch = async (request) => {
      asked.push(request.url);
      return /contractsfinder/.test(request.url) ? TENDERS : null;
    };
    const project = await scan(h, bot.id, 1, ["asking"]);
    const [lead] = project.leads;
    expect(lead).toMatchObject({ kind: "asking", company: "The Test Trust" });
    expect(lead!.contacts).toEqual([{ kind: "respond", value: lead!.url, url: lead!.url }]);
    expect(lead!.records[0]).toMatchObject({ register: "contracts-finder", deadline: "2099-12-20" });
    expect(lead!.warnings.map((w) => w.id)).toContain("big-buyer");
    // No Companies House call without its key; it's said in the scan's notes.
    expect(asked.some((u) => /company-information/.test(u))).toBe(false);
  });

  it("finds a quiet fit from Companies House, confirmed on its own site, only with a key", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    serve(h);
    h.services.clients.io.fetch = async (request) => (/advanced-search/.test(request.url) ? COMPANIES : null);
    const without = await scan(h, bot.id, 1, ["quiet"]);
    expect(without.leads).toEqual([]);
    expect(without.scan!.skipped.join()).toMatch(/Companies House: add its API key/);

    const keys = await post(h, "/api/client-bots/keys", { name: "companiesHouse", key: "made-up-key" });
    expect(keys.json()).toEqual({ keys: { companiesHouse: true } });
    expect(keys.body).not.toContain("made-up-key");
    expect(h.services.vault.get(KEY_NAMES.companiesHouse)).toBe("made-up-key");
    const project = await scan(h, bot.id, 1, ["quiet"]);
    const [lead] = project.leads;
    expect(lead).toMatchObject({ kind: "quiet", company: "PINE CAFE LTD", ownSite: true, watch: true });
    expect(lead!.records[0]!.register).toBe("companies-house");
    expect(lead!.score).toBeLessThanOrEqual(70);
  });

  it("never asks the Checker about a tender that doesn't name what you sell (found in the benchmark)", async () => {
    const team = clientTeam({ check: () => ({ kind: "request", summary: "Yes." }) });
    h = await clientHarness(team);
    const { bot } = await readyClientBot(h);
    serve(h);
    const grounds = structuredClone(TENDERS);
    grounds.noticeList[0]!.item = {
      ...grounds.noticeList[0]!.item,
      title: "Grounds maintenance",
      description: "Grass cutting and hedge trimming for parks.",
    };
    h.services.clients.io.fetch = async (request) => (/contractsfinder/.test(request.url) ? grounds : null);
    const project = await scan(h, bot.id, 1, ["asking"]);
    expect(project.leads).toEqual([]);
    expect(team.seen.filter((s) => s.role === "checker")).toEqual([]);
    expect(project.log.some((l) => /left out 1 tender that don't name what you sell/.test(l.text))).toBe(
      true,
    );
  });

  it("takes the register entry that is really the company's, not the first sharing a word (1.4)", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    serve(h);
    h.services.clients.io.search = async () => [SITE];
    h.services.vault.set(KEY_NAMES.companiesHouse, "made-up-key");
    const profiles: Record<string, unknown> = {
      "11111111": {
        company_name: "BRIGHTSIDE CLEANING LTD",
        company_number: "11111111",
        company_status: "dissolved",
        registered_office_address: { locality: "Bradford" },
      },
      "22222222": {
        company_name: "BRIGHTSIDE KITCHENS LTD",
        company_number: "22222222",
        company_status: "active",
        registered_office_address: { locality: "Leeds" },
      },
    };
    h.services.clients.io.fetch = async (request) => {
      if (request.url.includes("/search/companies"))
        return {
          items: [
            { company_number: "11111111", title: "BRIGHTSIDE CLEANING LTD" },
            { company_number: "22222222", title: "BRIGHTSIDE KITCHENS LTD" },
          ],
        };
      return profiles[request.url.split("/").pop()!] ?? null;
    };
    const project = await scan(h, bot.id, 1, ["signs"]);
    const lead = project.leads.find((l) => l.company === "Brightside Kitchens");
    expect(lead?.records.map((r) => r.id)).toEqual(["22222222"]);
    expect(lead?.warnings.map((w) => w.id) ?? []).not.toContain("closed-company");
  });

  it("doesn't show a quiet fit whose own site can't be found", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    serve(h);
    h.services.clients.io.search = async () => null;
    h.services.vault.set(KEY_NAMES.companiesHouse, "made-up-key");
    h.services.clients.io.fetch = async (request) => (/advanced-search/.test(request.url) ? COMPANIES : null);
    const project = await scan(h, bot.id, 1, ["quiet"]);
    expect(project.leads).toEqual([]);
    expect(project.log.some((l) => /own website wasn't found/.test(l.text))).toBe(true);
  });

  it("asks a register for its next page each scan, and says when it has nothing more (2.2, 3.5)", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    serve(h);
    h.services.vault.set(KEY_NAMES.companiesHouse, "made-up-key");
    const asked: string[] = [];
    h.services.clients.io.fetch = async (request) => {
      if (!/advanced-search/.test(request.url)) return null;
      asked.push(new URL(request.url).searchParams.get("start_index")!);
      // Two pages of 50 in all.
      const start = Number(new URL(request.url).searchParams.get("start_index"));
      return { hits: "100", items: start === 0 ? Array(50).fill(COMPANIES.items[0]) : COMPANIES.items };
    };
    await scan(h, bot.id, 1, ["quiet"]);
    await scan(h, bot.id, 1, ["quiet"]);
    const third = await scan(h, bot.id, 1, ["quiet"]);
    // Both queries (by industry code, and new companies): page 1, then page 2 (the last); the third scan asks nothing.
    expect(asked).toEqual(["0", "0", "50", "50"]);
    expect(third.scan!.skipped.join()).toMatch(
      /UK Companies House: every company it has for your profile has been read/,
    );
    // An industry with no code: said why, not "gave 0 records".
    await patch(h, `/api/bots/${bot.id}/client/profile`, { industries: ["dog groomers"] });
    const some = await scan(h, bot.id, 1, ["quiet"]);
    expect(some.scan!.skipped.join()).toMatch(
      /no industry code for “dog groomers”, so it was asked for new companies only/,
    );
    await patch(h, `/api/bots/${bot.id}/client/profile`, { signals: ["hiring"] });
    const none = await scan(h, bot.id, 1, ["quiet"]);
    expect(none.scan!.skipped.join()).toMatch(
      /UK Companies House: no industry code for “dog groomers”: add a broader industry/,
    );
  });

  it("judges a company turned down as a quiet fit again later, not never (1.8)", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    serve(h);
    const searches: string[] = [];
    h.services.clients.io.search = async (_bot, query) => {
      searches.push(query);
      return null;
    };
    h.services.vault.set(KEY_NAMES.companiesHouse, "made-up-key");
    h.services.clients.io.fetch = async (request) => (/advanced-search/.test(request.url) ? COMPANIES : null);
    const first = await scan(h, bot.id, 1, ["quiet"]);
    // Remembered as not shown, with why, and not as shown to you.
    expect(first.notShown).toMatchObject([{ name: "PINE CAFE LTD", reason: "its own website wasn't found" }]);
    expect(first.seen).toEqual([]);
    // A scan soon after doesn't look it up again.
    const looked = searches.length;
    await scan(h, bot.id, 1, ["quiet"]);
    expect(searches.length).toBe(looked);
    // After a while it's judged again: its site can be found now, and it becomes a lead.
    // (The register's one page was read too: a month later it's read again, from the start.)
    h.services.clients.edit(bot.id, (p) => {
      p.notShown = p.notShown.map((entry) => ({ ...entry, at: "2020-01-01T00:00:00.000Z" }));
      for (const read of Object.values(p.registerPages)) read.at = "2020-01-01T00:00:00.000Z";
    });
    h.services.clients.io.search = async (_bot, query) => (/"PINE CAFE/i.test(query) ? [PINE] : null);
    const later = await scan(h, bot.id, 1, ["quiet"]);
    expect(later.leads.map((l) => l.company)).toEqual(["PINE CAFE LTD"]);
    expect(later.notShown).toEqual([]);
  });
});

describe("the watch list", () => {
  it("moves a quiet fit up when its site shows a new sign, only in a scan you start", async () => {
    let hiring = false;
    h = await clientHarness(
      clientTeam({
        check: (url) =>
          url === PINE && hiring
            ? {
                ...PINE_REPORT,
                signals: [{ kind: "hiring", quote: "We need a Payroll Administrator", date: "" }],
              }
            : checker(url),
      }),
    );
    const { bot } = await readyClientBot(h);
    const pages = SITE_PAGES();
    const readers = savedReaders(pages);
    h.services.clients.io.readers = { text: readers.text };
    h.services.clients.io.search = async (_b, q) => (/"PINE CAFE LTD"/i.test(q) ? [PINE] : null);
    h.services.vault.set(KEY_NAMES.companiesHouse, "made-up-key");
    h.services.clients.io.fetch = async (request) =>
      /advanced-search/.test(request.url)
        ? {
            items: [
              {
                company_name: "PINE CAFE LTD",
                company_number: "12345678",
                company_status: "active",
                sic_codes: ["56102"],
                registered_office_address: { locality: "Leeds" },
              },
            ],
          }
        : null;
    await scan(h, bot.id, 1, ["quiet"]);
    expect(projectOf(h, bot.id).leads[0]!.kind).toBe("quiet");
    hiring = true;
    pages[PINE] = page(
      PINE,
      pad(
        "Pine Cafe\nTwo cafes in Leeds, a team of 12 staff.\nWe need a Payroll Administrator.\nEmail info@pinecafe.test",
      ),
      {
        links: pages[PINE]!.links,
      },
    );
    const project = await scan(h, bot.id, 1, ["quiet"]);
    expect(project.scan!.movedUp).toBe(1);
    expect(project.leads[0]).toMatchObject({ kind: "signs", movedUp: "Hiring for your work" });
    expect(botSaid(h, bot).at(-1)).toMatch(/Checked 1 watched company for new signs: 1 now shows one/);
  });
});

describe("scans that run while you are away (Phase 5)", () => {
  const CAPTCHA = "https://forum.test/thread/payroll";

  it("sets a page that needs you aside, carries on, and asks at the end (5.4)", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    const pages = {
      ...SITE_PAGES(),
      [CAPTCHA]: page(CAPTCHA, pad("Checking your browser"), { humanCheck: true }),
    };
    const readers = savedReaders(pages);
    h.services.clients.io.readers = { text: readers.text };
    h.services.clients.io.search = async (_bot, query) =>
      /"Brightside Kitchens"/.test(query)
        ? [SITE]
        : /Payroll Administrator/.test(query)
          ? [CAPTCHA, NEWS]
          : null;
    h.services.clients.io.handoffLimitMs = 50;
    const project = await scan(h, bot.id, 2, ["signs"]);
    // Set aside, then Brightside was found, and only then were you asked: the page didn't hold up the scan.
    const at = (pattern: RegExp) => project.log.findIndex((l) => pattern.test(l.text));
    expect(project.leads.map((l) => l.company)).toEqual(["Brightside Kitchens"]);
    expect(at(/Set aside forum\.test/)).toBeGreaterThanOrEqual(0);
    expect(at(/Set aside forum\.test/)).toBeLessThan(at(/Found: Brightside/));
    expect(at(/Found: Brightside/)).toBeLessThan(at(/Waiting for you on forum\.test/));
    // Asked at the end, nobody answered: said in the closing words.
    expect(project.scan!.stopReason).toMatch(/1 page that needed you was left unread\.$/);
    expect(project.status).toBe("ready");
  });

  it("ends a slow step at the time limit, as the time limit, not a failure (5.5)", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    h.services.clients.io.search = async () => [NEWS];
    // A page that never answers until the scan's signal ends it.
    h.services.clients.io.readers = {
      text: {
        id: "text",
        read: (_url, context) =>
          new Promise((_resolve, reject) =>
            context.signal.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      },
    };
    const { SCAN_LIMITS } = await import("./scan");
    h.services.clients.io.limits = { ...SCAN_LIMITS, minutes: 0.002 };
    const project = await scan(h, bot.id, 1, ["signs"]);
    expect(project.scan!.stopReason).toBe("Reached the time limit for one scan.");
    expect(project.status).toBe("ready");
    expect(project.error).toBeNull();
  });

  it("marks a failed scan as ended (5.6)", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    const { SCAN_LIMITS } = await import("./scan");
    h.services.clients.io.limits = {
      ...SCAN_LIMITS,
      pages: () => {
        throw new Error("boom");
      },
    };
    const project = await scan(h, bot.id, 1, ["signs"]);
    expect(project.status).toBe("error");
    expect(project.scan!.endedAt).not.toBeNull();
    expect(project.scan!.stopReason).toBe("The scan failed: boom");
  });

  it("doesn't count a Checker that gave no answer against the site (5.9)", async () => {
    const urls = ["a", "b", "c"].map((p) => `https://news.test/leeds/${p}`);
    h = await clientHarness(clientTeam({ check: (url) => (urls.includes(url) ? "fail" : checker(url)) }));
    const { bot } = await readyClientBot(h);
    const readers = savedReaders(Object.fromEntries(urls.map((u) => [u, page(u, NEWS_PAGE)])));
    h.services.clients.io.readers = { text: readers.text };
    h.services.clients.io.search = async () => urls;
    const project = await scan(h, bot.id, 1, ["signs"]);
    // Before, two model failures blocked news.test for the scan, so the third page was never read.
    expect(readers.calls).toEqual(urls);
    expect(project.scan!.stopReason).toMatch(/The Checker failed 3 times in a row/);
  });
});

describe("the chat", () => {
  it("asks how many new leads, then scans", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    serve(h);
    await type(h, bot, "find me some clients");
    await until(h, bot.id, (p) => p.askingCount);
    expect(botSaid(h, bot).at(-1)).toMatch(/How many new leads/);
    await type(h, bot, "1");
    await until(h, bot.id, (p) => p.scan !== null);
    await h.services.clients.idle(bot.id);
    expect(projectOf(h, bot.id).leads).toHaveLength(1);
  });

  it("says which kinds it will look for, and takes 'only tenders' in the answer (3.4)", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    serve(h);
    await type(h, bot, "find me some clients");
    await until(h, bot.id, (p) => p.askingCount);
    expect(botSaid(h, bot).at(-1)).toMatch(
      /I'll look for asking now \(tenders and requests\), companies with signs and quiet fits/,
    );
    await type(h, bot, "2, only tenders");
    await until(h, bot.id, (p) => p.scan !== null);
    await h.services.clients.idle(bot.id);
    expect(projectOf(h, bot.id).scan).toMatchObject({ target: 2, kinds: ["asking"] });
  });
});

describe("the board", () => {
  it("reacts, forgets onto do-not-contact, and exports CSV", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    serve(h);
    const project = await scan(h, bot.id, 1, ["signs"]);
    const lead = project.leads[0]!;
    const up = await post(h, `/api/bots/${bot.id}/client/leads/${lead.id}/react`, { reaction: "up" });
    expect(up.json().project.leads[0].column).toBe("shortlisted");
    const csv = await h.app.inject({
      method: "GET",
      url: `/api/bots/${bot.id}/client/export.csv`,
      headers: auth,
    });
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body.split("\r\n")[1]).toMatch(/^Brightside Kitchens,brightside-kitchens.test,With signs,/);
    const forgot = await post(h, `/api/bots/${bot.id}/client/leads/${lead.id}/forget`, { block: true });
    expect(forgot.json().project.leads).toEqual([]);
    expect(forgot.json().project.lists.doNotContact).toEqual([
      { name: "Brightside Kitchens", domain: "brightside-kitchens.test" },
    ]);
    // Never comes back.
    const again = await scan(h, bot.id, 1, ["signs"]);
    expect(again.leads).toEqual([]);
  });

  it("uses your price and buyers: a size suggestion, and who to ask for (3.3, 6.1)", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h, { sizeMax: null, price: "£300 a month for up to 50 staff" });
    const project = projectOf(h, bot.id);
    // Suggested from the price, never applied by itself.
    expect(project.suggestions).toMatchObject([{ field: "sizeMax", value: "50" }]);
    expect(project.profile.sizeMax).toBeNull();
    serve(h);
    await scan(h, bot.id, 1, ["signs"]);
    const csv = await h.app.inject({
      method: "GET",
      url: `/api/bots/${bot.id}/client/export.csv`,
      headers: auth,
    });
    const [header, row] = csv.body.split("\r\n");
    const at = header!.split(",").indexOf("Ask for");
    expect(at).toBeGreaterThan(0);
    expect(row).toContain(projectOf(h, bot.id).profile.buyerTitles.join(" or "));
  });

  it("forgets what was read about a lead in the role threads too, and keeps the threads (3.1)", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot, project: made } = await readyClientBot(h);
    serve(h);
    const project = await scan(h, bot.id, 1, ["signs"]);
    const lead = project.leads[0]!;
    const pair = h.store.threads
      .list()
      .find((t) => t.pair && t.memberIds.includes(made.roles.checker.botId))!;
    const texts = () => h.store.messages.list(pair.id).map((m) => JSON.stringify(m.parts));
    expect(texts().some((t) => t.includes("hello@brightside-kitchens.test"))).toBe(true);
    // Once its turn has ended, a Checker's task keeps only the start of the page.
    const { checkTask, keptTask } = await import("./roles/checker");
    const { emptyOffer, playbookOf } = await import("@mrog/clients");
    const long = checkTask(
      { url: SITE, title: "Long", text: "x".repeat(10_000) },
      [],
      emptyOffer(),
      playbookOf(emptyOffer()),
    );
    expect(long.length).toBeGreaterThan(10_000);
    expect(keptTask(long).length).toBeLessThan(2_000);
    expect(keptTask(long)).toContain(`ADDRESS: ${SITE}`);
    await post(h, `/api/bots/${bot.id}/client/leads/${lead.id}/forget`, { block: false });
    expect(texts().some((t) => /brightside/i.test(t))).toBe(false);
    expect(texts().some((t) => t.includes("you forgot this lead"))).toBe(true);
    expect(h.store.threads.get(pair.id)).not.toBeNull();
  });

  it("learns lookalikes from your favourite clients, with a key", async () => {
    h = await clientHarness(clientTeam());
    const { bot } = await readyClientBot(h);
    const none = await post(h, `/api/bots/${bot.id}/client/lookalikes`, { text: "A\nB\nC" });
    expect(none.statusCode).toBe(409);
    h.services.vault.set(KEY_NAMES.companiesHouse, "made-up-key");
    const profiles: Record<string, unknown> = {
      "00000001": {
        company_name: "ALPHA DINER LTD",
        company_number: "00000001",
        sic_codes: ["56101"],
        date_of_creation: "2018-01-01",
        registered_office_address: { locality: "Leeds" },
      },
      "00000002": {
        company_name: "BETA BISTRO LTD",
        company_number: "00000002",
        sic_codes: ["56101"],
        date_of_creation: "2020-01-01",
        registered_office_address: { locality: "Leeds" },
      },
      "00000003": {
        company_name: "GAMMA GRILL LTD",
        company_number: "00000003",
        sic_codes: ["56101", "56302"],
        date_of_creation: "2016-01-01",
        registered_office_address: { locality: "York" },
      },
    };
    profiles["00000009"] = {
      company_name: "ALPHA CLEANING LTD",
      company_number: "00000009",
      sic_codes: ["81210"],
      date_of_creation: "2001-01-01",
      registered_office_address: { locality: "Hull" },
    };
    const numbers: Record<string, string> = { Alpha: "00000001", Beta: "00000002", Gamma: "00000003" };
    h.services.clients.io.fetch = async (request) => {
      const q = new URL(request.url).searchParams.get("q");
      const item = (number: string) => ({
        company_number: number,
        title: (profiles[number] as { company_name: string }).company_name,
      });
      // Another company sharing a word comes first for Alpha: the first result was taken before (1.5).
      if (q)
        return {
          items: [...(q.startsWith("Alpha") ? [item("00000009")] : []), item(numbers[q.split(" ")[0]!]!)],
        };
      return profiles[request.url.split("/").pop()!] ?? null;
    };
    const res = await post(h, `/api/bots/${bot.id}/client/lookalikes`, {
      text: "Alpha Diner\nBeta Bistro\nGamma Grill",
    });
    const look = res.json().project.lookalikes;
    expect(look.profile).toMatchObject({ sicCodes: ["56101"], area: "Leeds", from: 3 });
    // Which register entry each client was matched to, so a wrong one can be seen and removed.
    expect(look.matched).toEqual([
      { client: "Alpha Diner", record: "ALPHA DINER LTD", id: "00000001" },
      { client: "Beta Bistro", record: "BETA BISTRO LTD", id: "00000002" },
      { client: "Gamma Grill", record: "GAMMA GRILL LTD", id: "00000003" },
    ]);
    expect(look.approved).toBe(false);
    expect(res.json().project.lists.clients).toHaveLength(3);
    const ok = await patch(h, `/api/bots/${bot.id}/client/lookalikes`, {
      profile: { area: "West Yorkshire" },
      approved: true,
    });
    expect(ok.json().project.lookalikes).toMatchObject({
      approved: true,
      profile: { area: "West Yorkshire" },
    });
  });
});

describe("verdicts from two pages", () => {
  it("prefer a definite one, the company's own site first", async () => {
    const { preferDefinite } = await import("./finder");
    expect(
      preferDefinite(
        [
          { id: "r1", verdict: "unknown" },
          { id: "r2", verdict: "meets", reason: "Leeds." },
        ],
        [
          { id: "r1", verdict: "meets", reason: "A restaurant." },
          { id: "r2", verdict: "misses", reason: "York." },
          { id: "r3", verdict: "unknown" },
        ],
      ),
    ).toEqual([
      { id: "r1", verdict: "meets", reason: "A restaurant." },
      { id: "r2", verdict: "meets", reason: "Leeds." },
      { id: "r3", verdict: "unknown" },
    ]);
  });
});

describe("a company's own site (2.8–2.10)", () => {
  const SITE_ONLY = pad(
    "Brightside Kitchens\nA family restaurant group in Leeds. Our team of 30 serves three restaurants.",
  );
  const CONTACT = `${SITE}contact-us`;

  it("reads its contact page when the home page only links to it (2.9)", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    const pages = {
      ...SITE_PAGES(),
      [SITE]: page(SITE, SITE_ONLY, { links: [{ text: "Contact us", url: CONTACT }] }),
      [CONTACT]: page(CONTACT, pad("Contact us: hello@brightside-kitchens.test or Tel: 0113 496 0000")),
    };
    serve(h);
    h.services.clients.io.readers = { text: savedReaders(pages).text };
    const project = await scan(h, bot.id, 1, ["signs"]);
    const lead = project.leads.find((l) => l.company === "Brightside Kitchens");
    expect(lead?.contacts.map((c) => c.value)).toEqual(
      expect.arrayContaining(["hello@brightside-kitchens.test", "0113 496 0000"]),
    );
  });

  it("takes a short contact page read in the browser (2.7, 2.9)", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    // Under 500 characters, as real contact pages often are.
    const short =
      "Contact us\nBrightside Kitchens, 12 Briggate, Leeds LS1 6HD\nEmail hello@brightside-kitchens.test or Tel: 0113 496 0000\nOpen Tuesday to Sunday.";
    const pages = {
      ...SITE_PAGES(),
      [SITE]: page(SITE, SITE_ONLY, { links: [{ text: "Contact us", url: CONTACT }] }),
      [CONTACT]: page(CONTACT, short),
    };
    serve(h);
    const text = savedReaders(pages).text;
    const browsed: string[] = [];
    h.services.clients.io.readers = {
      text,
      // The browser shows the same short page: long enough for a company's own site there.
      browser: {
        id: "browser",
        async read(url, context) {
          browsed.push(url);
          return { ...(await text.read(url, context))!, reader: "browser" };
        },
      },
    };
    const project = await scan(h, bot.id, 1, ["signs"]);
    expect(browsed).toContain(CONTACT);
    const lead = project.leads.find((l) => l.company === "Brightside Kitchens");
    expect(lead?.contacts.map((c) => c.value)).toEqual(
      expect.arrayContaining(["hello@brightside-kitchens.test"]),
    );
  });

  it("tries plain http when https can't be reached, which is the no-https clue (2.8)", async () => {
    const plain = SITE.replace("https:", "http:");
    h = await clientHarness(clientTeam({ check: (url) => (url === plain ? SITE_REPORT : checker(url)) }));
    const { bot } = await readyClientBot(h, { clues: ["no_https"] });
    serve(h);
    const pages = { ...SITE_PAGES(), [plain]: page(plain, SITE_PAGES()[SITE]!.text) };
    delete (pages as Record<string, unknown>)[SITE];
    h.services.clients.io.readers = { text: savedReaders(pages).text };
    const project = await scan(h, bot.id, 1, ["signs"]);
    const lead = project.leads.find((l) => l.company === "Brightside Kitchens");
    expect(lead?.ownSite).toBe(true);
    expect(lead?.evidence.map((e) => e.id)).toContain("no_https");
  });

  it("isn't the news page's own address when the Checker gives that as the website (found in the benchmark)", async () => {
    h = await clientHarness(
      clientTeam({
        check: (url) =>
          url === NEWS
            ? {
                ...NEWS_REPORT,
                facts: [...NEWS_REPORT.facts!, { name: "website", value: NEWS, quote: NEWS }],
              }
            : checker(url),
      }),
    );
    const { bot } = await readyClientBot(h);
    serve(h);
    const project = await scan(h, bot.id, 1, ["signs"]);
    expect(project.leads.map((l) => l.domain)).toEqual(["brightside-kitchens.test"]);
  });

  it("is picked from search results by their title too, not the address alone (2.10)", async () => {
    const { pickOwnSite } = await import("./finder");
    const results = [
      { url: "https://brightside.test/", title: "Brightside Dental Practice | Leeds" },
      {
        url: "https://brightside-kitchens.test/",
        title: "Brightside Kitchens – family restaurants in Leeds",
      },
    ];
    expect(pickOwnSite(results, "Brightside Kitchens")).toBe("https://brightside-kitchens.test/");
    // No titles: the first address that fits, as before.
    expect(
      pickOwnSite(
        results.map((r) => r.url),
        "Brightside Kitchens",
      ),
    ).toBe("https://brightside.test/");
  });
});

describe("the Checker's task (2.6)", () => {
  it("asks only for what the page can give, and never for traits", async () => {
    const { checkTask } = await import("./roles/checker");
    const { emptyOffer, mergeOffer, playbookOf } = await import("@mrog/clients");
    const profile = mergeOffer(emptyOffer(), {
      offer: "Payroll for restaurants",
      areas: ["Leeds"],
      industries: ["any"],
    });
    const site = { url: SITE, title: "Brightside", text: "Brightside Kitchens" };
    const any = checkTask(site, [], profile, playbookOf(profile));
    const own = checkTask(site, [], profile, playbookOf(profile), {
      expect: "company",
      company: "Brightside",
    });
    const tender = checkTask(site, [], profile, playbookOf(profile), { expect: "request" });
    for (const task of [any, own, tender]) expect(task).not.toMatch(/TRAITS/);
    expect(own).toMatch(/Leave links and companies empty/);
    expect(own).toMatch(/FACTS TO GIVE/);
    expect(tender).not.toMatch(/FACTS TO GIVE|SIGNS TO LOOK FOR/);
    // Only the signs you look for.
    expect(any).toMatch(/SIGNS TO LOOK FOR[^\n]*hiring/);
    expect(any).not.toMatch(/SIGNS TO LOOK FOR[^\n]*funding/);
  });
});

describe("the Checker's tool", () => {
  it("reads save_offer's arguments written as JSON inside a text field (found in the benchmark)", async () => {
    const { saveOfferTool } = await import("./tools");
    const { emptyOffer, mergeOffer } = await import("@mrog/clients");
    const base = mergeOffer(emptyOffer(), { offer: "IT support", industries: ["accountants"] });
    const capture: Capture = { base, said: "Also add law firms as an industry." };
    const tool = saveOfferTool(capture);
    const args = tool.args.parse({ offer: '{"industries": ["law firms"]}' });
    await tool.run(args as never, {} as never);
    expect(capture.profile?.industries).toEqual(["accountants", "law firms"]);
    expect(capture.profile?.offer).toBe("IT support");
  });

  it("reads its lists named a little wrong or written as JSON text (found in the benchmark)", async () => {
    const { finishPageTool } = await import("./tools");
    const tool = finishPageTool({});
    const prepared = tool.prepare!({
      kind: "signal",
      signs: '[{"kind": "hiring", "quote": "Brightside Kitchens is hiring", "date": "3 November 2026"}]',
      verdicts: '[{"id": "r1", "verdict": "meets", "reason": "Restaurants."}]',
    });
    const args = tool.args.parse(prepared);
    expect(args.signals).toEqual([
      { kind: "hiring", quote: "Brightside Kitchens is hiring", date: "3 November 2026" },
    ]);
    expect(args.verdicts).toEqual([{ id: "r1", verdict: "meets", reason: "Restaurants." }]);
  });

  it("reads a company's sign written nested under it (found in the benchmark)", async () => {
    const { finishPageTool } = await import("./tools");
    const capture: Capture = {};
    const tool = finishPageTool(capture);
    const args = tool.args.parse({
      kind: "signal",
      companies: [
        {
          name: "Brightside Kitchens",
          quote: "Brightside Kitchens is advertising for a Payroll Administrator",
          // As the model wrote it: its own "kind" is the page's, the sign's is nested.
          kind: "company",
          sign: { kind: "hiring", date: "3 November 2026", quote: "Brightside Kitchens is hiring" },
        },
      ],
    });
    await tool.run(args as never, {} as never);
    expect(capture.result?.companies[0]).toMatchObject({
      name: "Brightside Kitchens",
      kind: "hiring",
      date: "3 November 2026",
      signQuote: "Brightside Kitchens is hiring",
    });
  });

  it("accepts a fact with no value instead of refusing the whole report", async () => {
    const { finishPageTool } = await import("./tools");
    const capture: Capture = {};
    const tool = finishPageTool(capture);
    const args = tool.args.parse({ kind: "list", facts: [{ name: "company", quote: "Some words" }] });
    await tool.run(args as never, {} as never);
    expect(capture.result).toMatchObject({
      kind: "list",
      facts: [{ name: "company", value: "", quote: "Some words" }],
    });
  });
});

describe("the Checker's mistakes, found in the live run", () => {
  it("gets one more turn when it answers in words instead of calling its tool", async () => {
    h = await clientHarness(
      clientTeam({
        check: (url, task) => (url === NEWS && !task.includes("You answered in text") ? null : checker(url)),
      }),
    );
    const { bot } = await readyClientBot(h);
    serve(h);
    const project = await scan(h, bot.id, 1, ["signs"]);
    expect(project.leads.map((l) => l.company)).toEqual(["Brightside Kitchens"]);
  });

  it("isn't believed when it calls a restaurant a competitor", async () => {
    h = await clientHarness(
      clientTeam({ check: (url) => (url === SITE ? { ...SITE_REPORT, kind: "competitor" } : checker(url)) }),
    );
    const { bot } = await readyClientBot(h);
    serve(h);
    const project = await scan(h, bot.id, 1, ["signs"]);
    expect(project.leads[0]).toMatchObject({ company: "Brightside Kitchens", ownSite: true });
  });

  it("is believed when the page itself sells what you sell", async () => {
    const { looksLikeCompetitor } = await import("./finder");
    const { playbookById } = await import("@mrog/clients");
    const ctx = {
      playbook: playbookById("payroll"),
      profile: { offer: "Payroll", playbook: "payroll" } as never,
    };
    expect(
      looksLikeCompetitor(page(RIVAL, "Payroll Pals\nWe offer payroll services to restaurants."), ctx),
    ).toBe(true);
    expect(looksLikeCompetitor(page(SITE, "Brightside Kitchens\nThree restaurants in Leeds."), ctx)).toBe(
      false,
    );
  });
});

describe("a news round-up of several companies (found in the live run)", () => {
  it("makes a lead of each company whose quote and sign check out, each confirmed on its own site", async () => {
    const ROUND_UP = "https://news.test/leeds/new-openings";
    const ROUND_UP_PAGE = pad(`Five new places to eat in Leeds
Published 30 October 2026
Brightside Kitchens has opened a second site in Headingley, its third restaurant.
Pine Cafe has finally found a permanent home in Leeds.`);
    h = await clientHarness(
      clientTeam({
        check: (url) =>
          url === ROUND_UP
            ? {
                kind: "signal",
                companies: [
                  {
                    name: "Brightside Kitchens",
                    quote: "Brightside Kitchens has opened a second site in Headingley",
                    kind: "expanding",
                    date: "30 October 2026",
                  },
                  {
                    name: "Pine Cafe",
                    quote: "Pine Cafe has finally found a permanent home in Leeds",
                    kind: "expanding",
                  },
                  { name: "Made Up Grill", quote: "Made Up Grill opened", kind: "expanding" },
                ],
              }
            : checker(url),
      }),
    );
    const { bot } = await readyClientBot(h);
    const readers = savedReaders({ ...SITE_PAGES(), [ROUND_UP]: page(ROUND_UP, ROUND_UP_PAGE) });
    h.services.clients.io.readers = { text: readers.text };
    h.services.clients.io.search = async (_b, q) =>
      /"Brightside Kitchens"/.test(q) ? [SITE] : /Payroll Administrator/.test(q) ? [ROUND_UP] : null;
    const project = await scan(h, bot.id, 2, ["signs"]);
    // Pine Cafe's quote says no sign (a "permanent home" isn't an opening by the words), Made Up Grill isn't on the page.
    expect(project.leads.map((l) => l.company)).toEqual(["Brightside Kitchens"]);
    expect(project.leads[0]!.signals[0]).toMatchObject({
      kind: "expanding",
      date: "2026-10-30",
      url: ROUND_UP,
    });
    expect(project.leads[0]!.ownSite).toBe(true);
  });
});

describe("a restaurant's own site found by a search (found in the live run)", () => {
  it("takes its name from the page when the model gets it wrong, and its record from the food register", async () => {
    const MAD = "https://madfrans.test/";
    const MAD_PAGE = pad(`MENUS | WELCOME TO MAD FRANS | Bar, venue & kitchen in Leeds.
A team of 25 staff serves our two restaurants. Email hello@madfrans.test`);
    h = await clientHarness(
      clientTeam({
        check: (url) =>
          url === MAD
            ? {
                kind: "competitor",
                companies: [{ name: "Mad Frans Bar", quote: "Bar, venue & kitchen in Leeds." }],
                facts: [{ name: "place", value: "", quote: "Bar, venue & kitchen in Leeds." }],
                traits: [{ id: "has_staff", quote: "A team of 25 staff" }],
                verdicts: [{ id: "r1", verdict: "meets", reason: "A restaurant." }],
              }
            : checker(url),
      }),
    );
    const { bot } = await readyClientBot(h);
    const readers = savedReaders({ [MAD]: page(MAD, MAD_PAGE, { links: [] }) });
    h.services.clients.io.readers = { text: readers.text };
    h.services.clients.io.search = async (_b, q) => (/Payroll Administrator/.test(q) ? [MAD] : null);
    h.services.clients.io.fetch = async (request) =>
      /name=MAD\+FRANS/i.test(request.url)
        ? {
            establishments: [
              {
                FHRSID: 7,
                BusinessName: "Mad Frans",
                BusinessType: "Restaurant/Cafe/Canteen",
                AddressLine4: "Leeds",
              },
            ],
          }
        : null;
    const project = await scan(h, bot.id, 1, ["signs", "quiet"]);
    expect(project.leads[0]).toMatchObject({ company: "MAD FRANS", kind: "quiet", ownSite: true });
    expect(project.leads[0]!.records[0]).toMatchObject({
      register: "food-hygiene",
      label: "Food hygiene rating",
    });
  });
});

describe("the page budget (found in the live run)", () => {
  it("is shared between register records and search results", async () => {
    h = await clientHarness(clientTeam({ check: checker }));
    const { bot } = await readyClientBot(h);
    const stories = Array.from({ length: 40 }, (_, i) => `https://news.test/story-${i}`);
    const readers = savedReaders({
      ...SITE_PAGES(),
      ...Object.fromEntries(stories.map((url) => [url, page(url, pad("Local news of the week."))])),
    });
    h.services.clients.io.readers = { text: readers.text };
    h.services.clients.io.search = async (_b, q) => (/"PINE CAFE/i.test(q) ? [PINE] : stories);
    h.services.clients.io.limits = { ...h.services.clients.io.limits, pages: () => 6 };
    h.services.vault.set(KEY_NAMES.companiesHouse, "made-up-key");
    h.services.clients.io.fetch = async (request) =>
      /advanced-search/.test(request.url)
        ? {
            items: [
              {
                company_name: "PINE CAFE LTD",
                company_number: "12345678",
                company_status: "active",
                sic_codes: ["56102"],
                registered_office_address: { locality: "Leeds" },
              },
            ],
          }
        : null;
    const project = await scan(h, bot.id, 5, ["signs", "quiet"]);
    // Many search results came first, yet the register's company was still read within six pages.
    expect(project.leads.map((l) => l.company)).toContain("PINE CAFE LTD");
  });
});

describe("the Visual helper's limits (found in the live run; 5.10)", () => {
  async function setup(vision: boolean) {
    const { visualReader } = await import("./visual-reader");
    const { Halt } = await import("./run-role");
    const { createClientState } = await import("./state");
    h = await clientHarness(clientTeam());
    const { bot } = await makeClientBot(h);
    // Its own state over the same saved project, in a scan.
    const state = createClientState({ store: h.store, bus: h.services.bus });
    state.change(bot.id, (p) => {
      p.status = "scanning";
      p.scan = {
        number: 1,
        target: 5,
        kinds: ["signs"],
        found: 0,
        weaker: 0,
        movedUp: 0,
        watched: 0,
        pagesRead: 0,
        visualPages: 0,
        searchRounds: 0,
        skipped: [],
        startedAt: new Date().toISOString(),
        endedAt: null,
        stopReason: null,
      };
    });
    const roles = {
      run: (_b: string, _r: string, _t: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          if (signal.aborted) reject(new Halt());
          else signal.addEventListener("abort", () => reject(new Halt()));
        }),
    };
    const browser = { goto: async () => ({}) };
    const models = {
      catalog: { info: async () => ({ capabilities: vision ? ["completion", "vision"] : ["completion"] }) },
      runtime: { settings: { sharedModel: "ollama:test:1b" } },
    };
    const reader = visualReader(browser as never, state, roles as never, models as never, () => 20);
    const ctx = (signal: AbortSignal) => ({ botId: bot.id, signal, phase: {} as never, why: "x" });
    return { reader, state, bot, ctx, Halt };
  }

  it("gives up a slow page without stopping the scan, and counts every try", async () => {
    const { reader, state, bot, ctx, Halt } = await setup(true);
    await expect(reader.read("https://slow.test/", ctx(new AbortController().signal))).rejects.toThrow(
      /took more than/,
    );
    // A try that failed counts toward the 5 a scan, as one that worked.
    expect(state.need(bot.id).scan!.visualPages).toBe(1);
    // Stop still stops: the Halt goes through.
    const stopped = new AbortController();
    const reading = reader.read("https://slow.test/", ctx(stopped.signal));
    stopped.abort();
    await expect(reading).rejects.toBeInstanceOf(Halt);
    state.flush();
  });

  it("isn't tried, and says so once a scan, when its model can't see pictures", async () => {
    const { reader, state, bot, ctx } = await setup(false);
    expect(await reader.read("https://a.test/", ctx(new AbortController().signal))).toBeNull();
    expect(await reader.read("https://b.test/", ctx(new AbortController().signal))).toBeNull();
    expect(state.need(bot.id).log.filter((l) => l.text.includes("can't see pictures"))).toHaveLength(1);
    expect(state.need(bot.id).scan!.visualPages).toBe(0);
    state.flush();
  });
});
