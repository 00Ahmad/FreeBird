import { employerSite, freshNote, judge, readersFor, siteOf, sourceFor, type PageRead } from "@mrog/jobs";
import { MAX_SITE_NOTES, type JobReader } from "@mrog/shared";

import type { Handoffs } from "../jobs/handoff";
import type { PageReader, ReadContext } from "../jobs/readers/types";
import { Halt } from "./halt";
import type { TeamProject, TeamState } from "./state";

/**
 * A page, or why it was skipped. `gone`: it doesn't exist (a closed job), which says nothing about the site.
 * `needsYou`: only you can get past it (a CAPTCHA, a sign-in), and the scan set it aside for later. `timedOut`: you
 * were asked and nobody answered.
 */
export type ReadOutcome =
  { page: PageRead } | { skip: string; gone?: true; needsYou?: string; timedOut?: true };

export interface TeamReadingDeps<P extends TeamProject> {
  state: TeamState<P>;
  readers: Partial<Record<Exclude<JobReader, "you">, PageReader>>;
  handoffs: Handoffs;
  /** Re-reads the page in the bot's tab after you dealt with it. */
  reread(botId: string): Promise<PageRead>;
  /** Shows you the page in the bot's tab (opening it there first). */
  show(botId: string, url: string): Promise<void>;
}

/**
 * Reads one address for a team bot (one copy for the Job Bot and the Client Bot), cheapest reader first, stepping down
 * when code says the page didn't really load, and handing the page to you when only you can get past it. A site that
 * needed a costlier reader is noted, so the next scan starts there.
 */
export function createTeamPageReading<P extends TeamProject>(deps: TeamReadingDeps<P>) {
  // The readers and hand-offs are read at each call, so a test can swap them.
  const { state } = deps;

  const noteSite = (botId: string, url: string, reader: JobReader) =>
    state.change(botId, (project) => {
      // One employer on a job system that hosts many: one company's site needing the browser says nothing of another's.
      const host = employerSite(url);
      const others = project.siteNotes.filter((note) => note.host !== host);
      // Only a costlier reader is worth remembering: the ladder starts at the cheap ones anyway.
      const notes =
        reader === "browser" || reader === "visual" ? [...others, { host, reader, at: state.now() }] : others;
      project.siteNotes = notes.slice(-MAX_SITE_NOTES);
    });

  /** Waits for you on a page only you can get past; the page as it is after, or a skip. */
  const handOff = async (url: string, reason: string, context: ReadContext): Promise<ReadOutcome> => {
    const { botId, signal } = context;
    await deps.show(botId, url).catch(() => undefined);
    state.change(botId, (project) => {
      project.status = "waiting_for_you";
      project.handoff = { url, reason, since: state.now() };
      state.logLine(project, `Waiting for you on ${siteOf(url)}: ${reason}`);
    });
    context.phase.say(`${reason} Solve it in the browser, then press Continue (or Skip this page).`);
    let answer: Awaited<ReturnType<Handoffs["wait"]>>;
    try {
      answer = await deps.handoffs.wait(botId, signal);
    } catch {
      throw new Halt();
    } finally {
      state.change(botId, (project) => {
        if (project.status === "waiting_for_you") project.status = "scanning";
        project.handoff = null;
      });
    }
    if (answer === "timeout") return { skip: "nobody answered in time", timedOut: true };
    if (answer !== "continue") return { skip: "you skipped it" };
    const page = await deps.reread(botId);
    const verdict = judge(page);
    return verdict.kind === "ok"
      ? { page: { ...page, reader: "you" } }
      : { skip: `still not readable: ${verdict.reason}` };
  };

  /**
   * Reads a page. With `defer`, a page only you can get past isn't waited on: it comes back as `needsYou`, so the scan
   * carries on and asks you about such pages together at the end (see `askYou`).
   */
  const read = async (
    url: string,
    context: Omit<ReadContext, "why">,
    allowVisual: boolean,
    /** `minChars`: the least text a page read in the browser needs to count as loaded (see `judge`). */
    options: { defer?: boolean; minChars?: number } = {},
  ): Promise<ReadOutcome> => {
    const project = state.need(context.botId);
    const note = project.siteNotes.find((one) => one.host === employerSite(url));
    // An old note is ignored: the site may read the cheap way again.
    const noted = note && freshNote(note.at, new Date()) ? note.reader : undefined;
    const readers = deps.readers;
    const order = readersFor({
      api: sourceFor(url) !== null,
      noted,
      visual: allowVisual && !!readers.visual,
    });
    let why = "";
    for (const id of order) {
      if (id === "you") continue;
      const reader = readers[id];
      if (!reader) continue;
      let page: PageRead | null;
      try {
        page = await reader.read(url, { ...context, why });
      } catch (error) {
        if (error instanceof Halt || context.signal.aborted) throw new Halt();
        why = (error as Error).message.slice(0, 160);
        continue;
      }
      if (!page) continue;
      const verdict = judge(page, options.minChars !== undefined ? { minChars: options.minChars } : {});
      if (verdict.kind === "ok") {
        noteSite(context.botId, url, id);
        return { page };
      }
      if (verdict.kind === "gone") return { skip: verdict.reason, gone: true };
      if (verdict.kind === "needs_you") {
        // Seen as text, a sign-in wall is often only how the page looks without its scripts: the browser may show it.
        if (id === "text" && readers.browser && order.includes("browser")) {
          why = verdict.reason;
          continue;
        }
        if (options.defer) return { skip: verdict.reason, needsYou: verdict.reason };
        return handOff(url, verdict.reason, { ...context, why });
      }
      why = verdict.reason;
    }
    return { skip: why ? `couldn't read it (${why})` : "couldn't read it" };
  };

  /** Asks you about a page set aside earlier: shows it and waits, as a hand-off. */
  const askYou = (url: string, reason: string, context: Omit<ReadContext, "why">) =>
    handOff(url, reason, { ...context, why: "" });

  return { read, askYou };
}

export type TeamPageReading = ReturnType<typeof createTeamPageReading>;
