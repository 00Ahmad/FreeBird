import { judge, readersFor, siteOf, sourceFor, type PageRead } from "@mrog/jobs";
import { MAX_SITE_NOTES, type JobReader } from "@mrog/shared";

import type { Handoffs } from "./handoff";
import type { PageReader, ReadContext } from "./readers/types";
import { Halt } from "./run-role";
import type { JobState } from "./state";

/** The Visual helper reads at most this many pages a scan: each takes minutes on a local model. */
export const MAX_VISUAL_PAGES = 5;

/** A page, or why it was skipped; `gone`: it doesn't exist (a closed job), which says nothing about the site. */
export type ReadOutcome = { page: PageRead } | { skip: string; gone?: true };

export interface ReadPageDeps {
  state: JobState;
  readers: Partial<Record<Exclude<JobReader, "you">, PageReader>>;
  handoffs: Handoffs;
  /** Re-reads the page in the Job Bot's tab after you dealt with it. */
  reread(botId: string): Promise<PageRead>;
  /** Shows you the page in the Job Bot's tab (opening it there first). */
  show(botId: string, url: string): Promise<void>;
}

/**
 * Reads one address, cheapest reader first, stepping down when code says the page didn't really load, and handing
 * the page to you when only you can get past it. A site that needed a costlier reader is noted, so the next scan
 * starts there.
 */
export function createPageReading(deps: ReadPageDeps) {
  // The readers and hand-offs are read at each call, so a test can swap them.
  const { state } = deps;

  const noteSite = (botId: string, url: string, reader: JobReader) =>
    state.change(botId, (project) => {
      const host = siteOf(url);
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
    if (answer !== "continue")
      return { skip: answer === "timeout" ? "nobody answered in time" : "you skipped it" };
    const page = await deps.reread(botId);
    const verdict = judge(page);
    return verdict.kind === "ok"
      ? { page: { ...page, reader: "you" } }
      : { skip: `still not readable: ${verdict.reason}` };
  };

  const read = async (
    url: string,
    context: Omit<ReadContext, "why">,
    allowVisual: boolean,
  ): Promise<ReadOutcome> => {
    const project = state.need(context.botId);
    const noted = project.siteNotes.find((note) => note.host === siteOf(url))?.reader;
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
      const verdict = judge(page);
      if (verdict.kind === "ok") {
        noteSite(context.botId, url, id);
        return { page };
      }
      if (verdict.kind === "gone") return { skip: verdict.reason, gone: true };
      if (verdict.kind === "needs_you") return handOff(url, verdict.reason, { ...context, why });
      why = verdict.reason;
    }
    return { skip: why ? `couldn't read it (${why})` : "couldn't read it" };
  };

  return { read };
}

export type PageReading = ReturnType<typeof createPageReading>;
