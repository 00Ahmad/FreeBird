import { clientFact } from "@mrog/clients";
import { afterEach, describe, expect, it } from "vitest";

import { auth, type TestHarness } from "../testing";
import {
  botSaid,
  clientHarness,
  clientTeam,
  makeClientBot,
  NEWS,
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
    expect(botSaid(h, bot).at(-1)).toMatch(/1 watched company now shows signs/);
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
    const numbers: Record<string, string> = { Alpha: "00000001", Beta: "00000002", Gamma: "00000003" };
    h.services.clients.io.fetch = async (request) => {
      const q = new URL(request.url).searchParams.get("q");
      if (q) return { items: [{ company_number: numbers[q.split(" ")[0]!] }] };
      return profiles[request.url.split("/").pop()!] ?? null;
    };
    const res = await post(h, `/api/bots/${bot.id}/client/lookalikes`, {
      text: "Alpha Diner\nBeta Bistro\nGamma Grill",
    });
    const look = res.json().project.lookalikes;
    expect(look.profile).toMatchObject({ sicCodes: ["56101"], area: "Leeds", from: 3 });
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

describe("the Checker's tool", () => {
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

describe("the Visual helper's time limit (found in the live run)", () => {
  it("gives up a slow page without stopping the scan", async () => {
    const { visualReader } = await import("./visual-reader");
    const { Halt } = await import("./run-role");
    const roles = {
      run: (_b: string, _r: string, _t: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          if (signal.aborted) reject(new Halt());
          else signal.addEventListener("abort", () => reject(new Halt()));
        }),
    };
    const state = { load: () => ({ roles: { visual: { botId: "v" } } }) };
    const browser = { goto: async () => ({}) };
    const reader = visualReader(browser as never, state as never, roles as never, () => 20);
    const outer = new AbortController();
    await expect(
      reader.read("https://slow.test/", { botId: "b", signal: outer.signal, phase: {} as never, why: "x" }),
    ).rejects.toThrow(/took more than/);
    // Stop still stops: the Halt goes through.
    const stopped = new AbortController();
    const reading = reader.read("https://slow.test/", {
      botId: "b",
      signal: stopped.signal,
      phase: {} as never,
      why: "x",
    });
    stopped.abort();
    await expect(reading).rejects.toBeInstanceOf(Halt);
  });
});
