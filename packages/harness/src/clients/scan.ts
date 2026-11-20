import { randomUUID } from "node:crypto";

import {
  afterPage,
  anyIndustry,
  sicCodesFor,
  clearNotShown,
  companyPrints,
  nextPage,
  queryKey,
  USED_UP_DAYS,
  industryForCodes,
  isGoodLead,
  LIST_LABELS,
  listedIn,
  lookalikeText,
  mergeIntoLead,
  notShownFor,
  pageKey,
  pickPages,
  pickWatched,
  playbookOf,
  premisesCount,
  premisesFit,
  quietBar,
  recordSignals,
  registersFor,
  rememberNotShown,
  requirementsOf,
  scoreDraft,
  allSignalSearches,
  MAX_CODE_SEARCHES,
  namesServiceNear,
  serviceWords,
  serviceNamesOf,
  staffFromPremises,
  toLead,
  type BuildContext,
  type ClaimedVerdict,
  type Draft,
  type Register,
  type RegisterRecord,
} from "@mrog/clients";
import {
  canonicalUrl,
  deadKeys,
  employerSite,
  fold,
  isSeen,
  recentSearches,
  remember,
  rememberDead,
  siteOf,
} from "@mrog/jobs";
import {
  MAX_DEAD_PAGES,
  MAX_LEADS,
  MAX_NOT_SHOWN,
  MAX_SEARCHES_RUN,
  MAX_SEEN_COMPANIES,
  MAX_WATCH_PER_SCAN,
  type ClientProject,
  type LeadEvidence,
  type LeadKind,
} from "@mrog/shared";

import type { Phase } from "../jobs/phase";
import { addLead } from "./board";
import { NeedsYou, NobodyAnswered, type Finder, type Found, type SearchFn, type StepContext } from "./finder";
import type { Registers } from "./registers";
import { MAX_SEARCHES, searchTask } from "./roles/searcher";
import type { RoleRunner } from "./run-role";
import type { ClientState } from "./state";
import { companiesHouseLookalike } from "./lookalikes";

/** Limits on one scan, so a scan always ends. Tests shorten them through `limits`. */
export const SCAN_LIMITS = {
  /** Pages and records read: four per lead asked for, at least 30, at most 200. */
  pages: (target: number) => Math.min(200, Math.max(30, target * 4)),
  searchRounds: 3,
  minutes: 45,
  checkerFailures: 3,
  siteFailures: 2,
  /** Records taken from one register in one scan. */
  recordsPerRegister: 25,
};

/** The share of a scan's page budget the watch list may use (2.1). */
export const WATCH_SHARE = 0.25;

/** Why a register gave no query for the profile, in plain words (3.5). */
function cantHelp(registerId: string, label: string, industries: readonly string[]): string {
  if (registerId === "companies-house")
    return `${label}: no industry code for ${industries.map((i) => `“${i}”`).join(", ")}: add a broader industry (such as “restaurants” or “construction”), or look for new companies`;
  return `${label}: nothing in your profile it can search by`;
}

/** When a used-up register query is read again: the earliest of them, a month after it was used up. */
const againOn = (dates: readonly string[]) => {
  const first = [...dates].toSorted()[0];
  if (!first) return "next month";
  return new Date(Date.parse(first) + USED_UP_DAYS * 86_400_000).toISOString().slice(0, 10);
};

export interface ScanDeps {
  state: ClientState;
  roles: RoleRunner;
  finder: Finder;
  registers: Registers;
  search: SearchFn;
  limits?: typeof SCAN_LIMITS;
}

type Item =
  | { type: "url"; url: string }
  | { type: "tender"; record: RegisterRecord }
  | { type: "company"; record: RegisterRecord; evidence: LeadEvidence[]; label: string };

class ScanEnd extends Error {}

const KIND_LABEL: Record<LeadKind, string> = {
  asking: "asking now",
  signs: "with signs",
  quiet: "quiet fit",
};

/**
 * One scan: re-check the watch list, ask the registers, run searches built from signs, then read and check one page
 * or record at a time until `target` new good leads are found or a limit is reached.
 */
export function createScanner(deps: ScanDeps) {
  const { state, roles, finder, registers } = deps;
  const limits = () => deps.limits ?? SCAN_LIMITS;

  return async function scan(
    botId: string,
    target: number,
    kinds: LeadKind[],
    stopSignal: AbortSignal,
    phase: Phase,
  ): Promise<string> {
    const start = Date.now();
    // One deadline for the whole scan, passed down with Stop: a slow page or model turn is cut off at the time limit,
    // not only looked at between items (5.5).
    const deadline = AbortSignal.timeout(limits().minutes * 60_000);
    const signal = AbortSignal.any([stopSignal, deadline]);
    const timeIsUp = () => deadline.aborted && !stopSignal.aborted;
    const first = state.need(botId);
    const number = (first.scan?.number ?? 0) + 1;
    state.change(botId, (p) => {
      p.scan = {
        number,
        target,
        kinds,
        found: 0,
        weaker: 0,
        movedUp: 0,
        watched: 0,
        pagesRead: 0,
        visualPages: 0,
        searchRounds: 0,
        skipped: [],
        startedAt: state.now(),
        endedAt: null,
        stopReason: null,
      };
      p.lastTarget = target;
      p.lastKinds = kinds;
      state.logLine(p, `Scan ${number}: looking for ${target} new lead${target === 1 ? "" : "s"}`);
    });
    const profile = first.profile;
    const playbook = playbookOf(profile);
    const requirements = requirementsOf(profile);
    const serviceNames = serviceNamesOf(profile);
    const ctx: StepContext = {
      botId,
      signal,
      phase,
      profile,
      playbook,
      requirements,
      now: new Date(),
      defer: true,
    };
    const build = (verdicts: ClaimedVerdict[]): BuildContext => ({
      profile,
      playbook,
      requirements,
      verdicts,
      now: ctx.now,
    });
    const scanOf = (p: ClientProject) => p.scan!;
    const log = (text: string) => state.change(botId, (p) => state.logLine(p, text));
    const skipped = (text: string) =>
      state.change(botId, (p) => {
        scanOf(p).skipped = [...scanOf(p).skipped, text].slice(-20);
        state.logLine(p, `Skipped ${text}`);
      });

    const queue: Item[] = [];
    const read = new Set<string>();
    const tried: string[] = [];
    let failures = 0;
    let searchedNothing = 0;
    const siteFails = new Map<string, number>();
    const blocked = new Set<string>();
    /** Steps whose page needs you (a CAPTCHA, a sign-in): set aside, and asked about at the end (5.4). */
    const setAside: { item: Item; url: string; reason: string }[] = [];

    const progress = () => {
      const s = scanOf(state.need(botId));
      phase.say(
        `Scan ${number}: found ${s.found} of ${s.target} new leads (${s.pagesRead} pages and records read).`,
      );
    };
    const checkLimits = () => {
      const s = scanOf(state.need(botId));
      if (s.found >= target) throw new ScanEnd(`Found ${s.found} new lead${s.found === 1 ? "" : "s"}.`);
      if (s.pagesRead >= limits().pages(target)) throw new ScanEnd("Read the most pages one scan may.");
      if (Date.now() - start > limits().minutes * 60_000 || timeIsUp())
        throw new ScanEnd("Reached the time limit for one scan.");
    };
    const failedOn = (url: string) => {
      const site = employerSite(url);
      const count = (siteFails.get(site) ?? 0) + 1;
      siteFails.set(site, count);
      if (count === limits().siteFailures) {
        blocked.add(site);
        log(`Skipping the rest of ${site} this scan: ${count} of its pages couldn't be used`);
      }
    };
    /** A company already on the board, on your lists, or seen before: no need to read anything about it. */
    const known = (name: string, domain: string | null) => {
      const p = state.need(botId);
      return (
        listedIn({ name, domain }, p.lists) !== null ||
        isSeen(new Set(p.seen), companyPrints({ name, domain }))
      );
    };
    const service = serviceWords(playbook, serviceNames);
    /** Whether a tender's title or description names what you sell (code, no model). */
    const tenderNamesService = (record: RegisterRecord) =>
      namesServiceNear(`${record.title ?? ""} ${record.description ?? ""}`, /[\s\S]/, service, 4000);
    /** A register's company turned down lately as a quiet fit, whose record shows no sign: not read again yet. */
    const notShownYet = (record: RegisterRecord) =>
      record.kind !== "tender" &&
      recordSignals(record, ctx.now, ctx.now.toISOString()).length === 0 &&
      notShownFor(state.need(botId).notShown, { name: record.name, domain: null }, ctx.now) !== null;

    /** A checked draft onto the board: merged into a lead it already has, or a new lead when it passes. */
    const place = (draft: Draft, verdicts: ClaimedVerdict[]) => {
      const p = state.need(botId);
      const identity = { name: draft.company, domain: draft.domain };
      const listed = listedIn(identity, p.lists);
      if (listed) return log(`${draft.company} is on ${LIST_LABELS[listed]}: not shown`);
      const prints = companyPrints(identity);
      const existing = p.leads.find((lead) =>
        companyPrints({ name: lead.company, domain: lead.domain }).some((print) => prints.includes(print)),
      );
      if (existing) {
        state.change(botId, (q) => {
          const lead = q.leads.find((l) => l.id === existing.id)!;
          const fresh = mergeIntoLead(lead, draft, build(verdicts));
          if (fresh.length > 0) state.logLine(q, `New sign for ${lead.company}: ${fresh[0]!.quote}`);
          q.seen = remember(q.seen, prints, MAX_SEEN_COMPANIES);
        });
        return;
      }
      if (isSeen(new Set(p.seen), prints)) return log(`Already shown to you before: ${draft.company}`);
      const scored = scoreDraft(draft, build(verdicts));
      if (scored.kind === "quiet") {
        // Turned down lately as a quiet fit, and still no sign: not judged again yet.
        const before = notShownFor(p.notShown, identity, ctx.now);
        if (before) return log(`Not shown: ${draft.company}: ${before.reason} (${before.at.slice(0, 10)})`);
        const bar = quietBar({
          fit: scored.fit,
          evidence: draft.evidence.length,
          records: draft.records.length,
          ownSite: draft.ownSite,
        });
        if (bar) {
          // Kept apart from the companies shown to you: a later scan judges it again, with a sign or after a while.
          state.change(botId, (q) => {
            q.notShown = rememberNotShown(q.notShown, identity, bar, ctx.now, MAX_NOT_SHOWN);
            state.logLine(q, `Not shown: ${draft.company}: ${bar}`);
          });
          return;
        }
      }
      const lead = toLead(draft, scored, { id: randomUUID(), scan: number }, ctx.now);
      // Set inside the change below (TypeScript can't see that, hence the cast).
      let added = "added" as ReturnType<typeof addLead>;
      state.change(botId, (q) => {
        added = addLead(q, lead);
        if (added !== "added") {
          q.seen = remember(q.seen, prints, MAX_SEEN_COMPANIES);
          if (added === "weaker")
            state.logLine(
              q,
              `Not added: ${lead.company} (${lead.score}): the board is full of stronger leads`,
            );
          return;
        }
        q.notShown = clearNotShown(q.notShown, identity);
        q.seen = remember(q.seen, prints, MAX_SEEN_COMPANIES);
        const good = isGoodLead(lead.score);
        if (good) scanOf(q).found += 1;
        else scanOf(q).weaker += 1;
        state.logLine(
          q,
          `${good ? "Found" : "Weaker lead"}: ${lead.company} (${KIND_LABEL[lead.kind]}, ${lead.score})`,
        );
      });
      if (added === "full")
        throw new ScanEnd(
          `The board is full (${MAX_LEADS} leads) with leads you're working. Move some to Not a fit, or forget them, to make room.`,
        );
    };

    const handle = (found: Found, url: string | null) => {
      if ("draft" in found) {
        failures = 0;
        return place(found.draft, found.verdicts);
      }
      if ("drafts" in found) {
        failures = 0;
        for (const one of found.drafts) place(one.draft, one.verdicts);
        return;
      }
      if ("links" in found) {
        failures = 0;
        const next = pickPages(found.links, skipKeys(), serviceNames).slice(0, 10);
        queue.unshift(...next.map((link): Item => ({ type: "url", url: link })));
        return;
      }
      log(`Skipped${url ? ` ${siteOf(url)}` : ""}: ${found.skip}`);
      if (url && found.site) failedOn(url);
      // Led nowhere: remembered, so the next scan doesn't read it again soon (2.5).
      if (url && found.dead)
        state.change(botId, (q) => {
          q.deadPages = rememberDead(
            q.deadPages,
            url,
            found.skip,
            found.dead === "lasting",
            ctx.now,
            MAX_DEAD_PAGES,
          );
        });
      if (found.checkerFailed) {
        failures += 1;
        if (failures >= limits().checkerFailures)
          throw new ScanEnd(`The Checker failed ${failures} times in a row: ${found.checkerFailed}.`);
      } else failures = 0;
    };

    /** Pages read this scan, and pages that led nowhere in earlier ones (still fresh): not read again. */
    const skipKeys = () =>
      new Set([...read, ...deadKeys(state.need(botId).deadPages, ctx.now).map((key) => key.slice(2))]);

    /** Searches run in earlier scans lately, lower-cased: not run again yet (2.5). */
    const pastSearches = new Set(recentSearches(first.searchesRun, ctx.now));
    const ran = (query: string) =>
      tried.some((q) => q.toLowerCase() === query.toLowerCase()) || pastSearches.has(query.toLowerCase());

    /** The next searches code makes, not run this scan or lately: each place and industry in turn (2.3). */
    const nextCodeSearches = () =>
      allSignalSearches(profile, kinds, ctx.now)
        .map((s) => s.query)
        .filter((query) => !ran(query))
        .slice(0, MAX_CODE_SEARCHES);

    /** Runs searches and queues the pages worth reading. */
    const runSearches = async (queries: string[]) => {
      for (const query of queries) {
        if (ran(query)) continue;
        tried.push(query);
        state.change(botId, (q) => {
          q.searchesRun = [...q.searchesRun, { query, at: state.now() }].slice(-MAX_SEARCHES_RUN);
        });
        phase.say(`Scan ${number}: searching “${query}”…`);
        const results = await deps.search(botId, query, signal).catch((error: unknown) => {
          if (signal.aborted) throw error;
          log(`Search failed: ${(error as Error).message}`);
          return null;
        });
        const urls = results?.map((r) => (typeof r === "string" ? r : r.url)) ?? null;
        if (!urls || urls.length === 0) searchedNothing += 1;
        const picked = pickPages(urls ?? [], skipKeys(), serviceNames);
        queue.push(...picked.map((url): Item => ({ type: "url", url })));
      }
    };

    const searchMore = async () => {
      const p = state.need(botId);
      const round = scanOf(p).searchRounds;
      const searching = kinds.includes("asking") || kinds.includes("signs");
      if (!searching || round >= limits().searchRounds)
        throw new ScanEnd(
          !searching
            ? "Checked every company the registers gave."
            : searchedNothing > 0 && tried.length === searchedNothing
              ? "The web searches found nothing. A hidden browser often gets no results: set up a search service in Settings → Browser, or turn on Show the browser window."
              : "Ran out of places to look. Try again later, or widen your profile.",
        );
      state.change(botId, (q) => void (scanOf(q).searchRounds += 1));
      const code = nextCodeSearches();
      let model: string[] = [];
      // The Searcher only when code has nothing new left to search.
      if (code.length === 0) {
        phase.say(`Scan ${number}: planning searches…`);
        const done = [...tried, ...first.searchesRun.map((s) => s.query)].slice(-40);
        const reply = await roles.run(botId, "searcher", searchTask(profile, done, target), signal, {
          phase,
        });
        model = (reply.capture.plan?.searches ?? []).slice(0, MAX_SEARCHES);
        if (!reply.capture.plan)
          log(`The Searcher didn't plan any searches${reply.error ? `: ${reply.error}` : ""}`);
      }
      const before = queue.length;
      await runSearches([...code, ...model]);
      log(`Searches gave ${queue.length - before} pages worth reading`);
    };

    /**
     * The watched quiet fits, re-checked for new signs: never on a timer, only in a scan you start. They get their own
     * share of the page budget (a quarter, at most MAX_WATCH_PER_SCAN), so a small scan still looks for new leads
     * (2.1). One whose site couldn't be read keeps its place in the queue (3.6).
     */
    const watchList = async () => {
      if (state.need(botId).watchOff) return;
      const share = Math.min(MAX_WATCH_PER_SCAN, Math.floor(limits().pages(target) * WATCH_SHARE));
      for (const lead of pickWatched(state.need(botId).leads, share)) {
        checkLimits();
        phase.say(`Scan ${number}: checking ${lead.company} for new signs…`);
        let found: Awaited<ReturnType<Finder["recheck"]>> = null;
        try {
          found = lead.domain ? await finder.recheck(ctx, lead.domain, lead.company) : null;
        } catch (error) {
          // A watched site that wants a CAPTCHA or a sign-in isn't worth asking you about: it waits for the next scan.
          if (!(error instanceof NeedsYou)) throw error;
        }
        state.change(botId, (q) => {
          const live = q.leads.find((l) => l.id === lead.id);
          if (!live) return;
          scanOf(q).watched += 1;
          if (!found) {
            state.logLine(
              q,
              `Couldn't check ${live.company}: ${lead.domain ? "its site couldn't be read" : "no web address is known"}`,
            );
            return;
          }
          const fresh = mergeIntoLead(live, found, build([]));
          if (fresh.length > 0 && live.kind !== "quiet") {
            scanOf(q).movedUp += 1;
            state.logLine(q, `Moved up: ${live.company}: ${live.movedUp}`);
          }
        });
      }
    };

    /** The registers that fit the profile, and lookalikes of your clients: their records, queued. */
    const askRegisters = async (): Promise<{ tenders: Item[]; companies: Item[] }> => {
      const tenders: Item[] = [];
      const companies: Item[] = [];
      const take = (
        register: Register,
        records: RegisterRecord[],
        extra: (r: RegisterRecord) => LeadEvidence[],
      ) => {
        let kept = 0;
        let otherWork = 0;
        const said = () =>
          otherWork > 0 &&
          log(
            `${register.label}: left out ${otherWork} tender${otherWork === 1 ? "" : "s"} that don't name what you sell`,
          );
        for (const record of records) {
          // Stopped part way through the page: it's read again next scan, not skipped past.
          if (kept >= limits().recordsPerRegister) {
            said();
            return false;
          }
          if (known(record.name, null) || notShownYet(record)) continue;
          // A tender that doesn't name what you sell doesn't use up the register's share (Find a Tender lists all).
          if (record.kind === "tender" && !tenderNamesService(record)) {
            otherWork += 1;
            continue;
          }
          kept += 1;
          if (record.kind === "tender") tenders.push({ type: "tender", record });
          else companies.push({ type: "company", record, evidence: extra(record), label: register.label });
        }
        said();
        return true;
      };
      for (const register of registersFor(profile, playbook)) {
        if (!kinds.includes(register.finds)) continue;
        if (!registers.ready(register)) {
          skipped(`${register.label}: add its API key in the Client Bot's settings`);
          continue;
        }
        const all = register.queries(profile, playbook, ctx.now);
        // A register that can't help says why, instead of "gave 0 records" (3.5).
        if (all.length === 0) {
          skipped(cantHelp(register.id, register.label, profile.industries));
          continue;
        }
        if (
          register.id === "companies-house" &&
          !anyIndustry(profile) &&
          sicCodesFor(profile.industries).length === 0
        )
          skipped(
            `${register.label}: no industry code for ${profile.industries.map((i) => `“${i}”`).join(", ")}, so it was asked for new companies only: add a broader industry to search by industry`,
          );
        // Each query asks for its next page; one whose last page was read lately is left out (2.2).
        const memory = state.need(botId).registerPages;
        const usedUp: string[] = [];
        const queries = all.flatMap((query) => {
          if (!register.isLastPage) return [query];
          const next = nextPage(memory, queryKey(register, query), ctx.now);
          if ("usedUp" in next) {
            usedUp.push(next.usedUp.at.slice(0, 10));
            return [];
          }
          return [{ ...query, page: next.page }];
        });
        if (queries.length === 0) {
          skipped(
            `${register.label}: every company it has for your profile has been read (it's read again from ${againOn(usedUp)})`,
          );
          continue;
        }
        phase.say(`Scan ${number}: asking ${register.label}…`);
        const result = await registers.search(register, queries, signal);
        if ("error" in result) {
          skipped(`${register.label}: ${result.error}`);
          continue;
        }
        const notePages = (taken: boolean) =>
          state.change(botId, (q) => {
            for (const { query, last } of result.pages)
              q.registerPages = afterPage(
                q.registerPages,
                queryKey(register, query),
                { page: query.page ?? 1, last, taken },
                ctx.now,
              );
          });
        let records = result.records.map((r) =>
          r.sicCodes.length > 0
            ? { ...r, industry: r.industry ?? industryForCodes(r.sicCodes, profile.industries) }
            : r,
        );
        const counts = premisesCount(records);
        if (register.id === "food-hygiene") records = premisesFit(records, profile.industries);
        log(`${register.label} gave ${records.length} record${records.length === 1 ? "" : "s"}`);
        const allTaken = take(register, records, (r) => {
          const n = counts.get(fold(r.name)) ?? 0;
          const staff = staffFromPremises(r, profile.traits);
          return [
            ...(staff ? [staff] : []),
            ...(profile.traits.includes("multi_site") && n >= 2
              ? [
                  {
                    kind: "trait" as const,
                    id: "multi_site",
                    quote: `${n} premises on the ${register.label} register`,
                    url: r.url,
                  },
                ]
              : []),
          ];
        });
        notePages(allTaken);
      }
      const look = state.need(botId).lookalikes;
      if (kinds.includes("quiet") && look.approved && look.profile) {
        const result = await companiesHouseLookalike(registers, look.profile, ctx.now, signal);
        if ("error" in result) skipped(`Lookalikes: ${result.error}`);
        else {
          log(`Lookalikes (${lookalikeText(look.profile)}) gave ${result.records.length} records`);
          take(result.register, result.records, (r) => [
            {
              kind: "trait",
              id: "lookalike",
              quote: `Same industry code as your favourite clients (${r.sicCodes.join(", ")})`,
              url: r.url,
            },
          ]);
        }
      }
      return { tenders, companies };
    };

    const itemKey = (item: Item) =>
      item.type === "url" ? canonicalUrl(item.url) : `${item.record.register}:${item.record.id}`;

    /** One step: an address, a tender or a register's company. `step`: the scan's context, or the one asking you. */
    const runItem = async (item: Item, step: StepContext) => {
      if (item.type === "url") {
        const key = itemKey(item);
        if (!key || read.has(key) || blocked.has(employerSite(item.url))) return;
        read.add(key);
        handle(await finder.fromUrl(step, item.url), item.url);
        return;
      }
      const key = itemKey(item)!;
      if (read.has(key) || known(item.record.name, null) || notShownYet(item.record)) return;
      read.add(key);
      read.add(pageKey(item.record.url));
      phase.say(`Scan ${number}: checking ${item.record.name}…`);
      handle(
        item.type === "tender"
          ? await finder.fromTender(step, item.record)
          : await finder.fromCompanyRecord(step, item.record, item.evidence, item.label),
        null,
      );
    };

    /** A step whose page needs you is set aside, and counted against its site: the scan carries on (5.4). */
    const process = async (item: Item) => {
      try {
        await runItem(item, ctx);
      } catch (error) {
        if (!(error instanceof NeedsYou)) throw error;
        setAside.push({ item, url: error.url, reason: error.reason });
        failedOn(error.url);
        log(`Set aside ${siteOf(error.url)} for later: ${error.reason}`);
      }
    };

    /**
     * When the scan ends short of the number asked for, the steps set aside are tried again one at a time, asking you
     * about the page each needs. The first one nobody answers ends the asking. Not after Stop or the time limit.
     * Returns the closing words' note about pages left unread.
     */
    const askAboutSetAside = async (): Promise<string> => {
      const unread = (n: number) =>
        n > 0
          ? ` ${n} page${n === 1 ? "" : "s"} that needed you ${n === 1 ? "was" : "were"} left unread.`
          : "";
      if (setAside.length === 0) return "";
      if (stopSignal.aborted || timeIsUp() || scanOf(state.need(botId)).found >= target)
        return unread(setAside.length);
      // Asking you doesn't count toward the time limit: only Stop ends it.
      const asking: StepContext = { ...ctx, signal: stopSignal, defer: false };
      for (const [index, aside] of setAside.entries()) {
        if (scanOf(state.need(botId)).found >= target) break;
        const left = setAside.length - index;
        phase.say(`Scan ${number}: ${left} page${left === 1 ? " needs" : "s need"} you.`);
        const key = itemKey(aside.item);
        if (key) read.delete(key);
        try {
          await runItem(aside.item, asking);
        } catch (error) {
          if (error instanceof NobodyAnswered) {
            const rest = setAside.length - index - 1;
            log(`Nobody answered${rest > 0 ? `: skipped the other ${rest} page(s) that need you` : ""}`);
            // The page nobody answered was left unread too, as were the rest.
            return unread(rest + 1);
          }
          if (error instanceof ScanEnd) break;
          throw error;
        }
      }
      return "";
    };

    let ended: string;
    try {
      await watchList();
      const { tenders, companies } = await askRegisters();
      queue.push(...tenders);
      if (kinds.includes("asking") || kinds.includes("signs")) {
        state.change(botId, (q) => void (scanOf(q).searchRounds = 1));
        await runSearches(nextCodeSearches());
      }
      // Register records take turns with the search results, so neither can use up the whole page budget.
      const records = [...companies];
      let turn = 0;
      for (;;) {
        checkLimits();
        turn += 1;
        const next = (turn % 2 === 0 ? records.shift() : undefined) ?? queue.shift() ?? records.shift();
        if (!next) {
          await searchMore();
          continue;
        }
        await process(next);
        progress();
      }
    } catch (error) {
      // The deadline ended whatever was running (a Checker turn, a page): that is the time limit, not a Stop.
      if (!(error instanceof ScanEnd) && !timeIsUp()) throw error;
      ended = error instanceof ScanEnd ? error.message : "Reached the time limit for one scan.";
    }
    const unread = await askAboutSetAside();
    const found = scanOf(state.need(botId)).found;
    const reason =
      (found >= target
        ? `Found ${found} new lead${found === 1 ? "" : "s"}.`
        : found === 0
          ? ended
          : `Found ${found} of the ${target} you asked for: ${ended}`) + unread;
    state.change(botId, (p) => {
      scanOf(p).endedAt = state.now();
      scanOf(p).stopReason = reason;
      state.logLine(p, reason);
    });
    return reason;
  };
}

export type Scanner = ReturnType<typeof createScanner>;
