import { randomUUID } from "node:crypto";

import {
  buildMatch,
  canonicalUrl,
  employerSite,
  codeSearches,
  CODE_SEARCHES_PER_ROUND,
  checkFacts,
  checkNotes,
  deadKeys,
  factValue,
  fingerprints,
  isClosedPosting,
  isGoodMatch,
  isSeen,
  linksOnPage,
  LIST_LINKS,
  listPickLimit,
  looksLikeJob,
  mayFollowLinks,
  pickFromList,
  pickLeads,
  rankHits,
  recentSearches,
  remember,
  rememberDead,
  requirementsLeftOut,
  requirementsOf,
  scoreMatch,
  siteOf,
  warningsFor,
  type PageRead,
  type SearchHit,
} from "@mrog/jobs";
import {
  MAX_DEAD_PAGES,
  MAX_JOB_CARDS,
  MAX_SEARCHES_RUN,
  MAX_SEEN_JOBS,
  type JobCard,
  type JobProject,
} from "@mrog/shared";

import { checkTask, keptTask, PAGE_CHARS } from "./roles/checker";
import { MAX_CAREER_PAGES, MAX_SEARCHES, searchTask } from "./roles/searcher";
import type { Phase } from "./phase";
import { MAX_VISUAL_PAGES, type PageReading, type ReadOutcome } from "./read-page";
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

/**
 * Web search for the scan: the results (an address, with the title the search showed when there is one), or null when
 * the search engines gave nothing related.
 */
export type SearchFn = (
  botId: string,
  query: string,
  signal: AbortSignal,
) => Promise<(string | SearchHit)[] | null>;

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
    stopSignal: AbortSignal,
    phase: Phase,
  ): Promise<string> {
    const start = Date.now();
    // One deadline for the whole scan, passed down with Stop: a slow Checker turn or a slow page ends at it, instead
    // of the limit being looked at only between pages.
    const deadline = AbortSignal.timeout(limits().minutes * 60_000);
    const signal = AbortSignal.any([stopSignal, deadline]);
    const timeIsUp = () => deadline.aborted && !stopSignal.aborted;
    /** Pages only you can get past, set aside so the scan carries on; you're asked about them at the end. */
    const setAside: { url: string; reason: string }[] = [];
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
    const leftOut = requirementsLeftOut(startProject.profile);
    if (leftOut > 0)
      state.change(botId, (p) =>
        state.logLine(
          p,
          `${leftOut} of your least important requirements (must-haves or nice-to-haves at the end of the list) aren't checked: a small model loses track of a longer list`,
        ),
      );
    /** Searches run in the last two weeks, by earlier scans: not run again, and the Searcher is told of them. */
    const pastQueries = startProject.searchesRun
      .filter((run) => recentSearches([run], new Date()).length > 0)
      .map((run) => run.query);
    const skipQueries = new Set(pastQueries.map((query) => query.toLowerCase()));
    /** Searches this scan ran. */
    const ran: string[] = [];
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
    const skipSet = () => {
      const project = state.need(botId);
      return new Set([
        ...project.seen,
        ...deadKeys(project.deadPages, new Date()),
        ...[...read].map((key) => `u:${key}`),
      ]);
    };
    /**
     * Remembers a page that led nowhere, so later scans skip it (never a list: new jobs appear on those). `lasting`:
     * it won't come back (gone, closed, already shown).
     */
    const dead = (urls: string[], reason: string, lasting: boolean) =>
      state.change(botId, (p) => {
        for (const url of new Set(urls))
          p.deadPages = rememberDead(p.deadPages, url, reason, lasting, new Date(), MAX_DEAD_PAGES);
      });

    const searchMore = async () => {
      const project = state.need(botId);
      if (scanOf(project).searchRounds >= limits().searchRounds)
        throw new ScanEnd(
          ran.length > 0 && searchedNothing === ran.length
            ? "The web searches found nothing. A hidden browser often gets no results: set up a search service in Settings → Browser, or turn on Show the browser window."
            : "Ran out of places to look. Try again later, or widen your profile.",
        );
      state.change(botId, (p) => void (scanOf(p).searchRounds += 1));
      // Every round starts with searches of companies' own job systems, made from the profile by code: the next title,
      // place and job system not searched lately, so a later round or scan looks somewhere new.
      const careers = codeSearches(project.profile)
        .filter((query) => !skipQueries.has(query.toLowerCase()))
        .slice(0, CODE_SEARCHES_PER_ROUND);
      phase.say(`Scan ${number}: planning searches…`);
      const reply = await roles.run(
        botId,
        "searcher",
        searchTask(project.profile, [...pastQueries, ...ran], target),
        signal,
        { phase },
      );
      const plan = reply.capture.plan;
      if (!plan) {
        if (reply.error && careers.length === 0)
          throw new ScanEnd(`The Searcher's model failed: ${reply.error}`);
        state.change(botId, (p) => state.logLine(p, "The Searcher didn't plan any searches"));
      }
      const leads: string[] = (plan?.careerPages ?? [])
        .slice(0, MAX_CAREER_PAGES)
        .filter((url) => canonicalUrl(url));
      const titles = [...project.profile.titles, ...project.profile.relatedTitles];
      for (const query of [...careers, ...(plan?.searches ?? []).slice(0, MAX_SEARCHES)]) {
        if (skipQueries.has(query.toLowerCase())) continue;
        skipQueries.add(query.toLowerCase());
        ran.push(query);
        state.change(botId, (p) => {
          p.searchesRun = [
            ...p.searchesRun.filter((run) => run.query.toLowerCase() !== query.toLowerCase()),
            { query, at: state.now() },
          ].slice(-MAX_SEARCHES_RUN);
        });
        phase.say(`Scan ${number}: searching “${query}”…`);
        const hits = await deps.search(botId, query, signal).catch((error: unknown) => {
          if (signal.aborted) throw error;
          state.change(botId, (p) => state.logLine(p, `Search failed: ${(error as Error).message}`));
          return null;
        });
        if (!hits || hits.length === 0) searchedNothing += 1;
        // The titles the search showed put postings of jobs you want first, and drop plainly other jobs unread.
        leads.push(...rankHits(hits ?? [], titles));
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
        dead([page.url], "couldn't confirm a job", false);
        return;
      }
      const prints = fingerprints({
        url: page.url,
        company: factValue(checked.facts, "company"),
        title: factValue(checked.facts, "title"),
        location: factValue(checked.facts, "location"),
      });
      if (isSeen(new Set(state.need(botId).seen), prints)) {
        // The same job under another address: already shown, so this address needn't be read again either.
        dead([page.url], "a job already shown", true);
        return;
      }
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
        unchecked: 0,
      };
      let full = false;
      state.change(botId, (p) => {
        const placed = addCard(p, card);
        if (placed === "weaker") p.seen = remember(p.seen, prints, MAX_SEEN_JOBS);
        if (placed !== "added") {
          full = placed === "full";
          if (placed === "weaker")
            state.logLine(
              p,
              `Not added (the board is full, and every job in Found is a better match): ${factValue(card.facts, "title")}`,
            );
          return;
        }
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
      if (full)
        throw new ScanEnd(
          `The board is full (${MAX_JOB_CARDS} jobs) with jobs you're working on. Move some to Not for me or Rejected to make room.`,
        );
    };

    /**
     * The jobs a list page holds, picked by code: always for a job system's list; for another page only when it is
     * longer than the Checker reads and code finds jobs you want on it (else the Checker reads it as before).
     */
    const listByCode = (page: PageRead): { jobs: number; picked: string[] } | null => {
      const limit = listPickLimit(target);
      const profile = state.need(botId).profile;
      if (page.reader === "api" && page.links.length > 0)
        return { jobs: page.links.length, picked: pickFromList(page.links, profile, limit) };
      const jobLinks = page.links.filter((link) => looksLikeJob(link.url));
      if (page.text.length <= PAGE_CHARS || jobLinks.length < LIST_LINKS || !mayFollowLinks(page.url))
        return null;
      const picked = pickFromList(jobLinks, profile, limit);
      return picked.length > 0 ? { jobs: jobLinks.length, picked } : null;
    };

    /** Reads and checks one address; `pre`: the page as it is after you dealt with it (see the end of the scan). */
    const checkPage = async (url: string, pre?: ReadOutcome) => {
      if (!pre && blockedSites.has(employerSite(url))) return;
      const allowVisual = scanOf(state.need(botId)).visualPages < MAX_VISUAL_PAGES;
      const outcome =
        pre ?? (await reading.read(url, { botId, signal, phase }, allowVisual, { defer: true }));
      if ("skip" in outcome && outcome.needsYou) {
        const reason = outcome.needsYou;
        setAside.push({ url, reason });
        state.change(botId, (p) => state.logLine(p, `Set aside for you: ${siteOf(url)}: ${reason}`));
        // A site whose pages keep needing you (a sign-in for every job) is skipped like one that blocks the bot.
        failedOn(url);
        return;
      }
      if ("skip" in outcome) {
        state.change(botId, (p) => state.logLine(p, `Skipped ${siteOf(url)}: ${outcome.skip}`));
        // A closed job's missing page is about that job, not about the site blocking the bot; a page you skipped says
        // nothing about the site either.
        if (!outcome.gone && !pre) failedOn(url);
        else dead([url], outcome.skip, true);
        return;
      }
      const page = outcome.page;
      read.add(canonicalUrl(page.url) ?? page.url);
      // (The Visual helper counts its own tries, worked or not: see readers/visual.ts.)
      state.change(botId, (p) => void (scanOf(p).pagesRead += 1));
      // A posting that says it's closed needs no model; a list that mentions a closed job is still read.
      if (isClosedPosting(page)) {
        state.change(botId, (p) =>
          state.logLine(p, `Skipped ${siteOf(page.url)}: the page says the job is closed`),
        );
        dead([url, page.url], "the job is closed", true);
        return;
      }
      // A list code can read: a job system's own list, or a long list whose links name jobs you want. Every title is
      // checked by code and the ones that fit are queued: no model turn, and none missed past what a model would see.
      const fromList = listByCode(page);
      if (fromList) {
        const picked = pickLeads(fromList.picked, skipSet());
        queue.unshift(...picked);
        state.change(botId, (p) =>
          state.logLine(
            p,
            fromList.picked.length > 0
              ? `${siteOf(page.url)} lists ${fromList.jobs} jobs: ${picked.length} new ones fit your titles`
              : `${siteOf(page.url)} lists ${fromList.jobs} jobs, none with a title you want`,
          ),
        );
        return;
      }
      const reply = await roles.run(botId, "checker", checkTask(page, requirements), signal, {
        phase,
        url: page.url,
        keepAs: keptTask,
      });
      const result = reply.capture.result;
      if (!result) {
        // The model's failure, not the site's: two of them must not skip an employer for the rest of the scan.
        failures += 1;
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
      else if (result.kind === "other") dead([url, page.url], "not a job", false);
      else if (result.kind === "list" && mayFollowLinks(page.url))
        queue.unshift(...pickLeads(linksOnPage(result.links, page.links), skipSet()).slice(0, 10));
    };

    /**
     * The pages set aside for you, one at a time: you deal with each in the browser, or skip it. Once you leave one
     * unanswered, the rest are skipped without waiting: nobody is there.
     */
    const askAboutSetAside = async (): Promise<string> => {
      if (setAside.length === 0) return "";
      const unread = (n: number) =>
        ` ${n} page${n === 1 ? "" : "s"} that needed you ${n === 1 ? "was" : "were"} left unread.`;
      if (stopSignal.aborted || timeIsUp() || scanOf(state.need(botId)).found >= target)
        return unread(setAside.length);
      for (const [index, item] of setAside.entries()) {
        if (scanOf(state.need(botId)).found >= target) break;
        const left = setAside.length - index;
        phase.say(`Scan ${number}: ${left} page${left === 1 ? " needs" : "s need"} you.`);
        const outcome = await reading.askYou(item.url, item.reason, { botId, signal: stopSignal, phase });
        if ("skip" in outcome && outcome.timedOut) {
          const rest = setAside.length - index - 1;
          state.change(botId, (p) =>
            state.logLine(
              p,
              `Nobody answered${rest > 0 ? `: skipped the other ${rest} page(s) that need you` : ""}`,
            ),
          );
          // The page nobody answered was left unread too, as were the rest.
          return unread(rest + 1);
        }
        try {
          await checkPage(item.url, outcome);
        } catch (error) {
          if (error instanceof ScanEnd) break;
          throw error;
        }
      }
      return "";
    };

    let ended: string;
    try {
      for (;;) {
        const s = scanOf(state.need(botId));
        if (s.found >= target) throw new ScanEnd(`Found ${s.found} new job${s.found === 1 ? "" : "s"}.`);
        if (s.pagesRead >= limits().pages(target)) throw new ScanEnd("Read the most pages one scan may.");
        if (Date.now() - start > limits().minutes * 60_000 || timeIsUp())
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
      // The deadline ended whatever was running (a Checker turn, a page): that is the time limit, not a Stop.
      if (!(error instanceof ScanEnd) && !timeIsUp()) throw error;
      ended = error instanceof ScanEnd ? error.message : "Reached the time limit for one scan.";
    }
    const unread = await askAboutSetAside();
    const found = scanOf(state.need(botId)).found;
    const reason =
      (found >= target
        ? `Found ${found} new job${found === 1 ? "" : "s"}.`
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
