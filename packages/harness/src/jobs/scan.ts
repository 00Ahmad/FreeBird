import { randomUUID } from "node:crypto";

import {
  buildMatch,
  canonicalUrl,
  employerSite,
  careerSearches,
  checkFacts,
  checkNotes,
  factValue,
  fingerprints,
  isGoodMatch,
  isSeen,
  linksOnPage,
  mayFollowLinks,
  pickLeads,
  remember,
  requirementsOf,
  saysClosed,
  scoreMatch,
  siteOf,
  warningsFor,
  type PageRead,
} from "@mrog/jobs";
import { MAX_SEEN_JOBS, type JobCard, type JobProject } from "@mrog/shared";

import { checkTask } from "./roles/checker";
import { MAX_CAREER_PAGES, MAX_SEARCHES, searchTask } from "./roles/searcher";
import type { Phase } from "./phase";
import { MAX_VISUAL_PAGES, type PageReading } from "./read-page";
import type { RoleRunner } from "./run-role";
import type { JobState } from "./state";
import { addCard } from "./board";

/** Limits on one scan, so a scan always ends. Tests shorten them through `limits`. */
export const SCAN_LIMITS = {
  /** Pages read: four per job asked for, at least 30, at most 200. */
  pages: (target: number) => Math.min(200, Math.max(30, target * 4)),
  /** Rounds of new searches when the leads run out. */
  searchRounds: 3,
  minutes: 45,
  /** Checker turns that failed in a row before the scan gives up. */
  checkerFailures: 3,
  /** Pages of one site that couldn't be read (or gave the Checker nothing) before the rest of it is skipped. */
  siteFailures: 2,
};

/** Web search for the scan: result addresses, or null when the search engines gave nothing related. */
export type SearchFn = (botId: string, query: string, signal: AbortSignal) => Promise<string[] | null>;

export interface ScanDeps {
  state: JobState;
  roles: RoleRunner;
  reading: PageReading;
  search: SearchFn;
  limits?: typeof SCAN_LIMITS;
}

class ScanEnd extends Error {}

/** One scan: plan searches, collect leads, read and check them one at a time until `target` new jobs are found. */
export function createScanner(deps: ScanDeps) {
  const { state, roles, reading } = deps;
  const limits = () => deps.limits ?? SCAN_LIMITS;

  return async function scan(
    botId: string,
    target: number,
    signal: AbortSignal,
    phase: Phase,
  ): Promise<string> {
    const start = Date.now();
    const startProject = state.need(botId);
    const number = (startProject.scan?.number ?? 0) + 1;
    state.change(botId, (p) => {
      p.scan = {
        number,
        target,
        found: 0,
        weaker: 0,
        pagesRead: 0,
        visualPages: 0,
        searchRounds: 0,
        startedAt: state.now(),
        endedAt: null,
        stopReason: null,
      };
      p.lastTarget = target;
      state.logLine(p, `Scan ${number}: looking for ${target} new job${target === 1 ? "" : "s"}`);
    });
    const requirements = requirementsOf(startProject.profile);
    const tried: string[] = [];
    const queue: string[] = [];
    const read = new Set<string>();
    let failures = 0;
    let searchedNothing = 0;
    /** Sites that keep failing (job boards that block automated reading): the rest of their pages are skipped. */
    const siteFails = new Map<string, number>();
    const blockedSites = new Set<string>();
    const failedOn = (url: string) => {
      const site = employerSite(url);
      const count = (siteFails.get(site) ?? 0) + 1;
      siteFails.set(site, count);
      if (count === limits().siteFailures) {
        blockedSites.add(site);
        state.change(botId, (p) =>
          state.logLine(p, `Skipping the rest of ${site} this scan: ${count} of its pages couldn't be used`),
        );
      }
    };
    const scanOf = (p: JobProject) => p.scan!;
    const progress = () => {
      const s = scanOf(state.need(botId));
      phase.say(`Scan ${number}: found ${s.found} of ${s.target} new jobs (${s.pagesRead} pages read).`);
    };
    /** Addresses already shown or read this scan, as `pickLeads` skips them. */
    const skipSet = () => new Set([...state.need(botId).seen, ...[...read].map((key) => `u:${key}`)]);

    const searchMore = async () => {
      const project = state.need(botId);
      if (scanOf(project).searchRounds >= limits().searchRounds)
        throw new ScanEnd(
          searchedNothing > 0 && tried.length === searchedNothing
            ? "The web searches found nothing. A hidden browser often gets no results: set up a search service in Settings → Browser, or turn on Show the browser window."
            : "Ran out of places to look. Try again later, or widen your profile.",
        );
      const first = scanOf(project).searchRounds === 0;
      state.change(botId, (p) => void (scanOf(p).searchRounds += 1));
      // The first round starts with searches of companies' own job systems, made from the profile by code.
      const careers = first ? careerSearches(project.profile) : [];
      phase.say(`Scan ${number}: planning searches…`);
      const reply = await roles.run(botId, "searcher", searchTask(project.profile, tried, target), signal, {
        phase,
      });
      const plan = reply.capture.plan;
      if (!plan) {
        if (reply.error && careers.length === 0)
          throw new ScanEnd(`The Searcher's model failed: ${reply.error}`);
        state.change(botId, (p) => state.logLine(p, "The Searcher didn't plan any searches"));
      }
      const leads: string[] = (plan?.careerPages ?? [])
        .slice(0, MAX_CAREER_PAGES)
        .filter((url) => canonicalUrl(url));
      for (const query of [...careers, ...(plan?.searches ?? []).slice(0, MAX_SEARCHES)]) {
        if (tried.some((q) => q.toLowerCase() === query.toLowerCase())) continue;
        tried.push(query);
        phase.say(`Scan ${number}: searching “${query}”…`);
        const urls = await deps.search(botId, query, signal).catch((error: unknown) => {
          if (signal.aborted) throw error;
          state.change(botId, (p) => state.logLine(p, `Search failed: ${(error as Error).message}`));
          return null;
        });
        if (!urls || urls.length === 0) searchedNothing += 1;
        leads.push(...(urls ?? []));
      }
      const picked = pickLeads(leads, skipSet());
      queue.push(...picked);
      state.change(botId, (p) => state.logLine(p, `Searches gave ${picked.length} pages worth reading`));
    };

    const addJob = (
      page: PageRead,
      result: NonNullable<Awaited<ReturnType<RoleRunner["run"]>>["capture"]["result"]>,
    ) => {
      const checked = checkFacts(page.text, result.facts);
      if (!checked.confirmed) {
        state.change(botId, (p) =>
          state.logLine(
            p,
            `Couldn't confirm a job at ${siteOf(page.url)}: ${checked.dropped.join("; ") || "no title or company"}`,
          ),
        );
        return;
      }
      const prints = fingerprints({
        url: page.url,
        company: factValue(checked.facts, "company"),
        title: factValue(checked.facts, "title"),
        location: factValue(checked.facts, "location"),
      });
      if (isSeen(new Set(state.need(botId).seen), prints)) return;
      const match = buildMatch(requirements, result.verdicts, checked.facts);
      const { score } = scoreMatch(match);
      const card: JobCard = {
        id: randomUUID(),
        url: page.url,
        site: siteOf(page.url),
        readBy: page.reader,
        foundAt: state.now(),
        scan: number,
        column: "found",
        facts: checked.facts,
        summary: result.summary.slice(0, 300),
        match,
        score,
        // Only the rules' warnings: every one is about what the page says, not the Checker's own words.
        warnings: warningsFor({ page: page.text, facts: checked.facts, match, now: new Date() }),
        company: checkNotes(page.text, result.company),
        reaction: null,
        reason: null,
      };
      state.change(botId, (p) => {
        addCard(p, card);
        p.seen = remember(p.seen, prints, MAX_SEEN_JOBS);
        // Only a job like yours counts toward the number you asked for; a weak one is still on the board.
        const good = isGoodMatch(score);
        if (good) scanOf(p).found += 1;
        else scanOf(p).weaker += 1;
        state.logLine(
          p,
          `${good ? "Found" : "Weaker match"}: ${factValue(card.facts, "title")} at ${factValue(card.facts, "company")} (${score})`,
        );
      });
    };

    const checkPage = async (url: string) => {
      if (blockedSites.has(employerSite(url))) return;
      const allowVisual = scanOf(state.need(botId)).visualPages < MAX_VISUAL_PAGES;
      const outcome = await reading.read(url, { botId, signal, phase }, allowVisual);
      if ("skip" in outcome) {
        state.change(botId, (p) => state.logLine(p, `Skipped ${siteOf(url)}: ${outcome.skip}`));
        // A closed job's missing page is about that job, not about the site blocking the bot.
        if (!outcome.gone) failedOn(url);
        return;
      }
      const page = outcome.page;
      read.add(canonicalUrl(page.url) ?? page.url);
      state.change(botId, (p) => {
        scanOf(p).pagesRead += 1;
        if (page.reader === "visual") scanOf(p).visualPages += 1;
      });
      if (saysClosed(page.text)) return;
      const reply = await roles.run(botId, "checker", checkTask(page, requirements), signal, {
        phase,
        url: page.url,
      });
      const result = reply.capture.result;
      if (!result) {
        failures += 1;
        failedOn(page.url);
        state.change(botId, (p) =>
          state.logLine(
            p,
            `The Checker gave no answer on ${siteOf(page.url)}${reply.error ? `: ${reply.error}` : ""}`,
          ),
        );
        if (failures >= limits().checkerFailures)
          throw new ScanEnd(
            `The Checker failed ${failures} times in a row${reply.error ? `: ${reply.error}` : ""}.`,
          );
        return;
      }
      failures = 0;
      if (result.kind === "job") addJob(page, result);
      else if (result.kind === "list" && mayFollowLinks(page.url))
        queue.unshift(...pickLeads(linksOnPage(result.links, page.links), skipSet()).slice(0, 10));
    };

    try {
      for (;;) {
        const s = scanOf(state.need(botId));
        if (s.found >= target) throw new ScanEnd(`Found ${s.found} new job${s.found === 1 ? "" : "s"}.`);
        if (s.pagesRead >= limits().pages(target)) throw new ScanEnd("Read the most pages one scan may.");
        if (Date.now() - start > limits().minutes * 60_000)
          throw new ScanEnd("Reached the time limit for one scan.");
        const next = queue.shift();
        if (!next) {
          await searchMore();
          continue;
        }
        const key = canonicalUrl(next);
        if (!key || read.has(key)) continue;
        read.add(key);
        await checkPage(next);
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
