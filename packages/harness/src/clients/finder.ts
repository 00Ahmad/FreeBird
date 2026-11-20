import {
  checkCompanyFacts,
  checkSigns,
  traitsOf,
  clientFact,
  cluesOn,
  companyDomain,
  findContacts,
  mergeContacts,
  namesServiceNear,
  serviceWords,
  signsInQuote,
  foodHygiene,
  homeOf,
  isProviderPage,
  leadRecord,
  mergeFacts,
  nameOnSite,
  placeOf,
  quoteSays,
  recordFacts,
  recordPage,
  recordSignals,
  sameCompany,
  sameRecord,
  serviceNamesOf,
  sellsIt,
  siteFitsName,
  staffFromPremises,
  type ClaimedVerdict,
  type Draft,
  type FitRequirement,
  type Playbook,
  type RegisterRecord,
} from "@mrog/clients";
import {
  linksOnPage,
  mayFollowLinks,
  onPage,
  SHORT_PAGE_CHARS,
  siteOf,
  words,
  type PageRead,
} from "@mrog/jobs";
import { SIGNAL_KINDS, type LeadEvidence, type OfferProfile } from "@mrog/shared";

import type { Phase } from "../jobs/phase";
import { checkTask, keptTask, type CheckFocus } from "./roles/checker";
import { MAX_VISUAL_PAGES, type PageReading, type ReadOutcome } from "./read-page";
import type { Registers } from "./registers";
import type { RoleRunner } from "./run-role";
import type { ClientState } from "./state";
import type { CheckerResult } from "./tools";

/** One web search result: its address, and the title the search showed when there was one. */
export interface SearchHit {
  url: string;
  title?: string;
}

/** Web search for the scan: results (or bare addresses), or null when the search engines gave nothing related. */
export type SearchFn = (
  botId: string,
  query: string,
  signal: AbortSignal,
) => Promise<(string | SearchHit)[] | null>;

const hitOf = (result: string | SearchHit): SearchHit =>
  typeof result === "string" ? { url: result } : result;

/** Words of a company's name that its legal form adds, not its name. */
const LEGAL_WORDS = new Set([
  "ltd",
  "limited",
  "llp",
  "plc",
  "inc",
  "co",
  "company",
  "group",
  "the",
  "and",
  "uk",
]);

/**
 * Whether a result's title names the company: its first part is the company's name, or it holds every word of the
 * name (one shared word isn't enough: "Brightside Dental" isn't "Brightside Kitchens").
 */
function titleNames(title: string | undefined, name: string): boolean {
  if (!title) return false;
  const head = title.split(/\s[|–—-]\s|:\s/)[0] ?? "";
  const stem = (w: string) => (w.length > 3 ? w.replace(/s$/, "") : w);
  const want = words(name)
    .filter((w) => !LEGAL_WORDS.has(w))
    .map(stem);
  const have = new Set(words(title).map(stem));
  return sameCompany(head, name) || (want.length > 0 && want.every((w) => have.has(w)));
}

/**
 * The company's own site among search results (2.10): an address that fits its name, the one whose title also names
 * it first. Before, the title was thrown away and the first address that fitted was taken.
 */
export function pickOwnSite(results: readonly (string | SearchHit)[], name: string): string | null {
  const fitting = results.map(hitOf).filter((hit) => siteFitsName(hit.url, name));
  return (fitting.find((hit) => titleNames(hit.title, name)) ?? fitting[0])?.url ?? null;
}

/** What one scan step is working with. */
export interface StepContext {
  botId: string;
  signal: AbortSignal;
  phase: Phase;
  profile: OfferProfile;
  playbook: Playbook;
  requirements: FitRequirement[];
  now: Date;
  /** A page only you can get past is set aside (NeedsYou) instead of waited on; false when you're being asked. */
  defer?: boolean;
}

/** A page of this step needs you (a CAPTCHA, a sign-in): the scan sets the whole step aside and asks at the end. */
export class NeedsYou extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** You were asked about a page and nobody answered: the scan stops asking about the rest. */
export class NobodyAnswered extends Error {}

/** What checking one address or record found. */
export type Found =
  | { draft: Draft; verdicts: ClaimedVerdict[] }
  | { links: string[] }
  /** Several companies from one page. */
  | { drafts: { draft: Draft; verdicts: ClaimedVerdict[] }[] }
  /**
   * Nothing to keep; `site`: count it against the site (it couldn't be read). `dead`: the page led nowhere and is
   * remembered across scans (2.5): for a while, or for good when it won't come back (a missing page).
   */
  | { skip: string; site?: boolean; checkerFailed?: string; dead?: "while" | "lasting" };

/** A page that led nowhere: remembered, so a later scan doesn't read it again soon. */
const nowhere = (skip: string, lasting = false): Found => ({ skip, dead: lasting ? "lasting" : "while" });

export interface FinderDeps {
  state: ClientState;
  roles: RoleRunner;
  reading: PageReading;
  search: SearchFn;
  registers: Registers;
}

/**
 * Verdicts from two pages about one company: for each requirement, the first that says something (not "unknown"),
 * the own site's first; else the first at all.
 */
export function preferDefinite(first: ClaimedVerdict[], second: ClaimedVerdict[]): ClaimedVerdict[] {
  const all = [...first, ...second];
  const ids = [...new Set(all.map((v) => v.id))];
  return ids.map(
    (id) =>
      all.find((v) => v.id === id && v.verdict?.trim().toLowerCase() !== "unknown") ??
      all.find((v) => v.id === id)!,
  );
}

/** Companies taken from one round-up page. */
export const MAX_ROUND_UP = 5;

/** Said first on a retry, when the Checker answered without calling its tool. */
export const RETRY_LINE =
  "You answered in text last time, so nothing was recorded. This time you must call finish_page (only facts and signs with an exact quote), then reply with one short sentence.";

/** Whether a page's own words show a business that sells what you sell, or a list of such businesses. */
export function looksLikeCompetitor(page: PageRead, ctx: Pick<StepContext, "playbook" | "profile">): boolean {
  return (
    sellsIt(`${page.title}\n${page.text}`, ctx.playbook.sells) ||
    isProviderPage(page.title, page.text, serviceNamesOf(ctx.profile))
  );
}

/**
 * Checks one lead source at a time: an address from a search, a tender, or a register entry. Each reads its pages
 * through the ladder, asks the Checker about them, and hands back a draft whose every part code has checked. It never
 * decides whether a lead is new or good: the scan does.
 */
export function createFinder(deps: FinderDeps) {
  const { state, roles, reading } = deps;

  /**
   * Reads a page through the ladder. The Visual helper (minutes a page on a local model) is only worth it for a
   * company's own site; a search result that won't read any other way is skipped.
   */
  /**
   * Reads one address. `ownSite`: a company's home page, worth the Visual helper. `short`: a page of the company's own
   * site, often a few lines (a picture-led home page, a contact page), which counts as loaded in the browser (2.7).
   */
  const read = async (
    ctx: StepContext,
    url: string,
    options: { ownSite?: boolean; short?: boolean } = {},
  ): Promise<ReadOutcome> => {
    const allowVisual =
      !!options.ownSite && (state.need(ctx.botId).scan?.visualPages ?? 0) < MAX_VISUAL_PAGES;
    const outcome = await reading.read(
      url,
      { botId: ctx.botId, signal: ctx.signal, phase: ctx.phase },
      allowVisual,
      {
        defer: ctx.defer ?? false,
        ...(options.short || options.ownSite ? { minChars: SHORT_PAGE_CHARS } : {}),
      },
    );
    if ("needsYou" in outcome && outcome.needsYou) throw new NeedsYou(url, outcome.needsYou);
    if ("timedOut" in outcome && outcome.timedOut) throw new NobodyAnswered();
    // The Visual helper counts its own tries (each one, worked or not).
    if ("page" in outcome) state.change(ctx.botId, (p) => void (p.scan && (p.scan.pagesRead += 1)));
    return outcome;
  };

  /**
   * A company's home page: over https, and when that can't be reached at all, over plain http (2.8). A site that only
   * answers that way is the "no secure connection" clue, seen by code from the address it was read at.
   */
  const readHome = async (ctx: StepContext, url: string): Promise<ReadOutcome> => {
    const outcome = await read(ctx, url, { ownSite: true });
    if ("page" in outcome || outcome.gone || !url.startsWith("https://")) return outcome;
    const plain = await read(ctx, url.replace(/^https:/, "http:"), { ownSite: true });
    return "page" in plain ? plain : outcome;
  };

  const check = async (
    ctx: StepContext,
    page: PageRead,
    focus: CheckFocus = {},
  ): Promise<{ result: CheckerResult } | { error: string }> => {
    const task = checkTask(page, ctx.requirements, ctx.profile, ctx.playbook, focus);
    const options = { phase: ctx.phase, url: page.url, keepAs: keptTask };
    let reply = await roles.run(ctx.botId, "checker", task, ctx.signal, options);
    // A small model often writes its report as text instead of calling the tool: one more turn that says so.
    if (!reply.capture.result && !reply.error)
      reply = await roles.run(ctx.botId, "checker", `${RETRY_LINE}\n\n${task}`, ctx.signal, options);
    const result = reply.capture.result;
    if (result?.kind === "competitor" && !looksLikeCompetitor(page, ctx))
      // The Checker's "competitor" is only believed when the page's own words show it: a restaurant isn't one.
      return {
        result: {
          ...result,
          kind: focus.expect === "company" || companyDomain(page.url) ? "company" : "other",
        },
      };
    return result ? { result } : { error: reply.error ?? "it answered without calling finish_page" };
  };

  /**
   * The ways to reach a company from its own page; when the page only links to a contact page, that page is read too
   * (no model) and its inbox and phone line taken (2.9). A lead with no way to reach it never counts as good.
   */
  const contactsOn = async (ctx: StepContext, page: PageRead) => {
    const domain = companyDomain(page.url);
    const found = findContacts(page, domain);
    if (found.some((c) => c.kind === "email" || c.kind === "phone")) return found;
    const link = found.find((c) => c.kind === "contact_page" && c.value !== page.url);
    if (!link) return found;
    try {
      // A contact page is often only a few lines: short is fine in the browser, without the Visual helper.
      const outcome = await read({ ...ctx, defer: true }, link.value, { short: true });
      return "page" in outcome ? mergeContacts(found, findContacts(outcome.page, domain)) : found;
    } catch (error) {
      // A contact page that wants a CAPTCHA isn't worth asking you about: the link is still there.
      if (error instanceof NeedsYou) return found;
      throw error;
    }
  };

  /** The facts, signs, traits, clues and contacts a company's own page shows, all checked by code. */
  const fromOwnPage = async (ctx: StepContext, page: PageRead, result: CheckerResult) => {
    let checked = checkCompanyFacts(page, result.facts);
    // The model often gets its own facts wrong on a company's home page; the name is then read from the page by code.
    const name = checked.confirmed ? null : nameOnSite(page);
    if (name)
      checked = checkCompanyFacts(page, [
        { name: "company", value: name, quote: name },
        ...result.facts.filter((f) => f.name.trim().toLowerCase() !== "company"),
      ]);
    const clues: LeadEvidence[] = cluesOn(page, ctx.profile.clues, ctx.now).map((clue) => ({
      kind: "clue",
      id: clue.id,
      quote: clue.text,
      url: page.url,
    }));
    return {
      facts: checked.facts.map((f) =>
        f.name === "website" && f.value === null ? { ...f, value: companyDomain(page.url) } : f,
      ),
      confirmed: checked.confirmed,
      signals: checkSigns(page, result.signals, ctx.profile, ctx.playbook, ctx.now),
      evidence: [...traitsOf(page, result.traits, ctx.profile), ...clues],
      contacts: await contactsOn(ctx, page),
    };
  };

  /**
   * A company's own site: the address the page gave (checked), else the first search result whose address fits its
   * name; read and checked as that company. "competitor" when it sells what you sell.
   */
  const ownSite = async (
    ctx: StepContext,
    name: string,
    place: string | null,
    hint: string | null,
  ): Promise<{ page: PageRead; result: CheckerResult } | "competitor" | null> => {
    /** The site at an address, read and checked as this company's; null when it isn't, or can't be read. */
    const tryHome = async (url: string) => {
      const outcome = await readHome(ctx, url);
      if (!("page" in outcome)) return null;
      const checked = await check(ctx, outcome.page, { expect: "company", company: name });
      if (!("result" in checked)) return null;
      if (checked.result.kind === "competitor") return "competitor" as const;
      if (checked.result.kind !== "company") return null;
      const said = clientFact(checkCompanyFacts(outcome.page, checked.result.facts).facts, "company");
      // A site that names another company isn't this one's.
      if (said && !sameCompany(said, name) && !sameCompany(nameOnSite(outcome.page), name)) return null;
      return { page: outcome.page, result: checked.result };
    };
    // The address the page gave first; when that isn't the company's site, a search for it (found in the benchmark:
    // a news page's own address was given as the company's website).
    if (hint) {
      const fromHint = await tryHome(homeOf(hint));
      if (fromHint) return fromHint;
    }
    const town = (place ?? "").split(",")[0]?.trim() || placeOf(ctx.profile.areas);
    const results = await deps.search(ctx.botId, `"${name}" ${town}`.trim(), ctx.signal).catch(() => null);
    const fit = pickOwnSite(results ?? [], name);
    const domain = fit ? companyDomain(fit) : null;
    if (!domain || domain === hint) return null;
    return tryHome(homeOf(domain));
  };

  /** A draft from one page about a company plus, when found, its own site. */
  const withOwnSite = async (
    ctx: StepContext,
    first: { page: PageRead; result: CheckerResult },
    asking: boolean,
  ): Promise<Found> => {
    const { page, result } = first;
    const checked = checkCompanyFacts(page, result.facts);
    const company = clientFact(checked.facts, "company");
    if (!company) return nowhere(`couldn't confirm a company at ${siteOf(page.url)}`);
    const signals = checkSigns(page, result.signals, ctx.profile, ctx.playbook, ctx.now);
    if (signals.length === 0)
      return nowhere(`no sign of need on ${siteOf(page.url)} checked out against the page`);
    // "Asking now" only when an asking sign checked out on the page: a 9B Checker called a café's own hiring page a
    // request, which put it in the top band with the page as the notice to respond to.
    asking = asking && signals.some((s) => s.kind === "asking");
    // The page's own address, given as "the website", is the news site's, not the company's (unless it fits the name).
    const given = companyDomain(clientFact(checked.facts, "website"));
    const hint = given && (given !== companyDomain(page.url) || siteFitsName(given, company)) ? given : null;
    const site = await ownSite(ctx, company, clientFact(checked.facts, "place"), hint);
    if (site === "competitor") return nowhere(`${company} sells what you sell: a competitor`);
    const own = site && (await fromOwnPage(ctx, site.page, site.result));
    const draft: Draft = {
      company,
      domain: own ? companyDomain(site.page.url) : hint,
      url: page.url,
      readBy: page.reader,
      facts: own ? mergeFacts(own.facts, checked.facts) : checked.facts,
      signals: [...signals, ...(own?.signals ?? [])],
      evidence: own?.evidence ?? traitsOf(page, result.traits, ctx.profile),
      records: [],
      contacts: [
        ...(asking ? [{ kind: "respond" as const, value: page.url, url: page.url }] : []),
        ...(own?.contacts ?? []),
      ],
      ownSite: !!own,
      summary: result.summary,
      pages: [page.text, ...(site ? [site.page.text] : [])],
      asking,
    };
    return { draft, verdicts: preferDefinite(site?.result.verdicts ?? [], result.verdicts) };
  };

  /**
   * A page about several companies: each one whose quote is on the page, names it and says a sign (all by code) gets
   * its own site looked up and becomes a draft of its own. At most MAX_ROUND_UP per page: each costs a search and a read.
   */
  const fromRoundUp = async (ctx: StepContext, page: PageRead, result: CheckerResult): Promise<Found> => {
    const drafts: { draft: Draft; verdicts: ClaimedVerdict[] }[] = [];
    for (const named of result.companies) {
      if (drafts.length >= MAX_ROUND_UP) break;
      const name = named.name.trim();
      if (!name || !onPage(page.text, named.quote) || !quoteSays(name, named.quote)) continue;
      // A kind that isn't a sign ("competitor", "company"): the sign the company's own words say, found by code.
      const kind = (SIGNAL_KINDS as readonly string[]).includes(named.kind)
        ? named.kind
        : (signsInQuote(named.quote, ctx.profile, ctx.playbook, ctx.now)[0] ?? named.kind);
      // The words about the company may say the sign; else the sign's own quote, when it gave one.
      const signals = checkSigns(
        page,
        [{ ...named, kind }, ...(named.signQuote ? [{ ...named, kind, quote: named.signQuote }] : [])],
        ctx.profile,
        ctx.playbook,
        ctx.now,
      ).slice(0, 1);
      if (signals.length === 0) continue;
      const site = await ownSite(ctx, name, null, null);
      if (site === "competitor") continue;
      const own = site && (await fromOwnPage(ctx, site.page, site.result));
      const facts = mergeFacts(own?.facts ?? [], [{ name: "company", value: name, quote: named.quote }]);
      drafts.push({
        draft: {
          company: name,
          domain: own ? companyDomain(site.page.url) : null,
          url: page.url,
          readBy: page.reader,
          facts,
          signals: [...signals, ...(own?.signals ?? [])],
          evidence: own?.evidence ?? [],
          records: [],
          contacts: own?.contacts ?? [],
          ownSite: !!own,
          summary: own ? site.result.summary : named.quote,
          pages: [page.text, ...(site ? [site.page.text] : [])],
          asking: false,
        },
        verdicts: preferDefinite(site?.result.verdicts ?? [], result.verdicts),
      });
    }
    return drafts.length > 0
      ? { drafts }
      : nowhere(`none of the companies on ${siteOf(page.url)} checked out against the page`);
  };

  /** An address from a search or a list page. */
  const fromUrl = async (ctx: StepContext, url: string): Promise<Found> => {
    const outcome = await read(ctx, url);
    if (!("page" in outcome))
      return outcome.gone
        ? { ...nowhere(outcome.skip, true), site: false }
        : { skip: outcome.skip, site: true };
    const page = outcome.page;
    // A list of providers is one by its own words: no Checker turn for it (2.4).
    if (isProviderPage(page.title, page.text, serviceNamesOf(ctx.profile)))
      return nowhere(`${siteOf(page.url)} lists providers like you: competitors, not clients`);
    const checked = await check(ctx, page, { expect: null });
    // A model that gave no answer says nothing about the site (5.9): it counts only toward the Checker's failures.
    if (!("result" in checked)) return { skip: "the Checker gave no answer", checkerFailed: checked.error };
    const result = checked.result;
    switch (result.kind) {
      case "list":
        return { links: mayFollowLinks(page.url) ? linksOnPage(result.links, page.links) : [] };
      case "competitor":
        return nowhere(`${siteOf(page.url)} is a competitor or a list of them`);
      case "request":
        return withOwnSite(ctx, { page, result }, true);
      case "signal":
        return result.companies.length > 0
          ? fromRoundUp(ctx, page, result)
          : withOwnSite(ctx, { page, result }, false);
      case "company": {
        const own = await fromOwnPage(ctx, page, result);
        const company = clientFact(own.facts, "company");
        if (!own.confirmed || !company) return nowhere(`couldn't confirm a company at ${siteOf(page.url)}`);
        const record = await lookUp(ctx, company, clientFact(own.facts, "place"));
        return {
          draft: {
            company,
            domain: companyDomain(page.url),
            url: page.url,
            readBy: page.reader,
            facts: record ? mergeFacts(own.facts, recordFacts(record)) : own.facts,
            signals: own.signals,
            evidence: [
              ...own.evidence,
              ...(record && !own.evidence.some((e) => e.id === "has_staff")
                ? [staffFromPremises(record, ctx.profile.traits)].filter((e) => e !== null)
                : []),
            ],
            records: record
              ? [
                  leadRecord(
                    record,
                    record.register === "companies-house" ? "Companies House" : "Food hygiene rating",
                  ),
                ]
              : [],
            contacts: own.contacts,
            ownSite: true,
            summary: result.summary,
            pages: [page.text],
            asking: false,
          },
          verdicts: result.verdicts,
        };
      }
      default:
        return nowhere(`nothing about a client at ${siteOf(page.url)}`);
    }
  };

  /** The register entry for a company found on the web, when a key is saved: an official record to confirm it. */
  const lookUp = async (
    ctx: StepContext,
    name: string,
    place: string | null,
  ): Promise<RegisterRecord | null> => {
    if (deps.registers.hasKey("companiesHouse")) {
      // The register's entry for this company, by name and place: never the first result that shares a word.
      const found = await deps.registers.findCompany(name, ctx.signal, place).catch(() => null);
      if (found) return found;
    }
    // A food business: the food hygiene register needs no key.
    if (!foodHygiene.fits(ctx.profile, ctx.playbook)) return null;
    const premises = await deps.registers
      .findPremises(name, placeOf(ctx.profile.areas), ctx.signal)
      .catch(() => []);
    return premises.find((p) => sameRecord(p, name, place)) ?? null;
  };

  /** A tender: the Checker confirms it asks for what you sell; the record is the evidence. */
  const fromTender = async (ctx: StepContext, record: RegisterRecord): Promise<Found> => {
    // A tender that doesn't name your service isn't asked about at all: in the benchmark a 9B Checker called a
    // grounds-maintenance tender a request for payroll.
    const service = serviceWords(ctx.playbook, serviceNamesOf(ctx.profile));
    if (!namesServiceNear(`${record.title ?? ""} ${record.description ?? ""}`, /[\s\S]/, service, 4000))
      return { skip: `the tender “${record.title}” doesn't name what you sell` };
    const page = recordPage(record);
    state.change(ctx.botId, (p) => void (p.scan && (p.scan.pagesRead += 1)));
    const checked = await check(ctx, page, { expect: "request" });
    if (!("result" in checked)) return { skip: "the Checker gave no answer", checkerFailed: checked.error };
    if (checked.result.kind !== "request")
      return { skip: `the tender “${record.title}” isn't for what you sell` };
    const at = ctx.now.toISOString();
    return {
      draft: {
        company: record.name,
        domain: null,
        url: record.url,
        readBy: "api",
        facts: recordFacts(record),
        signals: recordSignals(record, ctx.now, at),
        evidence: [],
        records: [leadRecord(record, `Tender: ${record.title}`)],
        contacts: [{ kind: "respond", value: record.url, url: record.url }],
        ownSite: false,
        summary: checked.result.summary || record.title || "",
        pages: [page.text],
        asking: true,
      },
      verdicts: checked.result.verdicts,
    };
  };

  /**
   * A register entry for a company that may never have posted anything: the record confirms it officially, its own
   * site confirms it exists and shows its traits, clues and contacts.
   */
  const fromCompanyRecord = async (
    ctx: StepContext,
    record: RegisterRecord,
    extra: LeadEvidence[],
    label: string,
  ): Promise<Found> => {
    const site = await ownSite(ctx, record.name, record.place, companyDomain(record.website));
    if (site === "competitor") return { skip: `${record.name} sells what you sell: a competitor` };
    const own = site && (await fromOwnPage(ctx, site.page, site.result));
    const at = ctx.now.toISOString();
    const signals = recordSignals(record, ctx.now, at).filter((s) => ctx.profile.signals.includes(s.kind));
    return {
      draft: {
        company: record.name,
        domain: own ? companyDomain(site.page.url) : null,
        url: record.url,
        readBy: "api",
        facts: own ? mergeFacts(recordFacts(record), own.facts) : recordFacts(record),
        signals: [...signals, ...(own?.signals ?? [])],
        evidence: [...extra, ...(own?.evidence ?? [])],
        records: [leadRecord(record, label)],
        contacts: own?.contacts ?? [],
        ownSite: !!own,
        summary: site ? site.result.summary : "",
        pages: [recordPage(record).text, ...(site ? [site.page.text] : [])],
        asking: false,
      },
      verdicts: site?.result.verdicts ?? [],
    };
  };

  /** A watched company's own site read again, for new signs. */
  const recheck = async (ctx: StepContext, domain: string, name: string): Promise<Partial<Draft> | null> => {
    const outcome = await readHome(ctx, homeOf(domain));
    if (!("page" in outcome)) return null;
    const checked = await check(ctx, outcome.page, { expect: "company", company: name });
    if (!("result" in checked) || checked.result.kind !== "company") return null;
    const own = await fromOwnPage(ctx, outcome.page, checked.result);
    return {
      signals: own.signals,
      evidence: own.evidence,
      contacts: own.contacts,
      facts: own.facts,
      pages: [outcome.page.text],
    };
  };

  return { fromUrl, fromTender, fromCompanyRecord, recheck };
}

export type Finder = ReturnType<typeof createFinder>;
