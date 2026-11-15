import { randomUUID } from "node:crypto";

import {
  companyPrints,
  industryForCodes,
  isGoodLead,
  LIST_LABELS,
  listedIn,
  lookalikeText,
  mergeIntoLead,
  pageKey,
  pickPages,
  pickWatched,
  playbookOf,
  premisesCount,
  premisesFit,
  quietBar,
  registersFor,
  requirementsOf,
  scoreDraft,
  serviceNamesOf,
  signalSearches,
  staffFromPremises,
  toLead,
  type BuildContext,
  type ClaimedVerdict,
  type Draft,
  type Register,
  type RegisterRecord,
} from "@mrog/clients";
import { canonicalUrl, employerSite, fold, isSeen, remember, siteOf } from "@mrog/jobs";
import { MAX_SEEN_COMPANIES, type ClientProject, type LeadEvidence, type LeadKind } from "@mrog/shared";

import type { Phase } from "../jobs/phase";
import { addLead } from "./board";
import type { Finder, Found, SearchFn, StepContext } from "./finder";
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
    signal: AbortSignal,
    phase: Phase,
  ): Promise<string> {
    const start = Date.now();
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
    const ctx: StepContext = { botId, signal, phase, profile, playbook, requirements, now: new Date() };
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
      if (Date.now() - start > limits().minutes * 60_000)
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
      if (isSeen(new Set(p.seen), prints)) return;
      const scored = scoreDraft(draft, build(verdicts));
      if (scored.kind === "quiet") {
        const bar = quietBar({
          fit: scored.fit,
          evidence: draft.evidence.length,
          records: draft.records.length,
          ownSite: draft.ownSite,
        });
        if (bar) {
          state.change(botId, (q) => {
            q.seen = remember(q.seen, prints, MAX_SEEN_COMPANIES);
            state.logLine(q, `Not shown: ${draft.company}: ${bar}`);
          });
          return;
        }
      }
      const lead = toLead(draft, scored, { id: randomUUID(), scan: number }, ctx.now);
      state.change(botId, (q) => {
        addLead(q, lead);
        q.seen = remember(q.seen, prints, MAX_SEEN_COMPANIES);
        const good = isGoodLead(lead.score);
        if (good) scanOf(q).found += 1;
        else scanOf(q).weaker += 1;
        state.logLine(
          q,
          `${good ? "Found" : "Weaker lead"}: ${lead.company} (${KIND_LABEL[lead.kind]}, ${lead.score})`,
        );
      });
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
      if (found.checkerFailed) {
        failures += 1;
        if (failures >= limits().checkerFailures)
          throw new ScanEnd(`The Checker failed ${failures} times in a row: ${found.checkerFailed}.`);
      } else failures = 0;
    };

    const skipKeys = () => new Set(read);

    /** Runs searches and queues the pages worth reading. */
    const runSearches = async (queries: string[]) => {
      for (const query of queries) {
        if (tried.some((q) => q.toLowerCase() === query.toLowerCase())) continue;
        tried.push(query);
        phase.say(`Scan ${number}: searching “${query}”…`);
        const urls = await deps.search(botId, query, signal).catch((error: unknown) => {
          if (signal.aborted) throw error;
          log(`Search failed: ${(error as Error).message}`);
          return null;
        });
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
      const code = signalSearches(profile, kinds, round, ctx.now).map((s) => s.query);
      let model: string[] = [];
      if (round > 0) {
        phase.say(`Scan ${number}: planning searches…`);
        const reply = await roles.run(botId, "searcher", searchTask(profile, tried, target), signal, {
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

    /** The watched quiet fits, re-checked for new signs: never on a timer, only in a scan you start. */
    const watchList = async () => {
      if (state.need(botId).watchOff) return;
      for (const lead of pickWatched(state.need(botId).leads)) {
        checkLimits();
        phase.say(`Scan ${number}: checking ${lead.company} for new signs…`);
        const found = lead.domain ? await finder.recheck(ctx, lead.domain, lead.company) : null;
        state.change(botId, (q) => {
          const live = q.leads.find((l) => l.id === lead.id);
          if (!live) return;
          const fresh = mergeIntoLead(live, found ?? {}, build([]));
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
        for (const record of records) {
          if (kept >= limits().recordsPerRegister) break;
          if (known(record.name, null)) continue;
          kept += 1;
          if (record.kind === "tender") tenders.push({ type: "tender", record });
          else companies.push({ type: "company", record, evidence: extra(record), label: register.label });
        }
      };
      for (const register of registersFor(profile, playbook)) {
        if (!kinds.includes(register.finds)) continue;
        if (!registers.ready(register)) {
          skipped(`${register.label}: add its API key in the Client Bot's settings`);
          continue;
        }
        phase.say(`Scan ${number}: asking ${register.label}…`);
        const result = await registers.search(register, register.queries(profile, playbook, ctx.now), signal);
        if ("error" in result) {
          skipped(`${register.label}: ${result.error}`);
          continue;
        }
        let records = result.records.map((r) =>
          r.sicCodes.length > 0
            ? { ...r, industry: r.industry ?? industryForCodes(r.sicCodes, profile.industries) }
            : r,
        );
        const counts = premisesCount(records);
        if (register.id === "food-hygiene") records = premisesFit(records, profile.industries);
        log(`${register.label} gave ${records.length} record${records.length === 1 ? "" : "s"}`);
        take(register, records, (r) => {
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

    const process = async (item: Item) => {
      if (item.type === "url") {
        const key = canonicalUrl(item.url);
        if (!key || read.has(key) || blocked.has(employerSite(item.url))) return;
        read.add(key);
        handle(await finder.fromUrl(ctx, item.url), item.url);
        return;
      }
      const key = `${item.record.register}:${item.record.id}`;
      if (read.has(key) || known(item.record.name, null)) return;
      read.add(key);
      read.add(pageKey(item.record.url));
      phase.say(`Scan ${number}: checking ${item.record.name}…`);
      handle(
        item.type === "tender"
          ? await finder.fromTender(ctx, item.record)
          : await finder.fromCompanyRecord(ctx, item.record, item.evidence, item.label),
        null,
      );
    };

    try {
      await watchList();
      const { tenders, companies } = await askRegisters();
      queue.push(...tenders);
      if (kinds.includes("asking") || kinds.includes("signs")) {
        state.change(botId, (q) => void (scanOf(q).searchRounds = 1));
        await runSearches(signalSearches(profile, kinds, 0, ctx.now).map((s) => s.query));
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
      if (!(error instanceof ScanEnd)) throw error;
      const found = scanOf(state.need(botId)).found;
      const reason =
        found >= target || found === 0
          ? error.message
          : `Found ${found} of the ${target} you asked for: ${error.message}`;
      state.change(botId, (p) => {
        scanOf(p).endedAt = state.now();
        scanOf(p).stopReason = reason;
        state.logLine(p, reason);
      });
      return reason;
    }
  };
}

export type Scanner = ReturnType<typeof createScanner>;
