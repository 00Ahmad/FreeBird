import { factValue, isGoodMatch, mergeProfile, missingForApproval, scoreLabel } from "@mrog/jobs";
import type {
  CreateJobBotInput,
  JobColumn,
  JobProject,
  JobReader,
  ReactToJobInput,
  UpdateJobProfileInput,
} from "@mrog/shared";

import type { Services } from "../services";
import { answerSuggestion, moveCard, react, rescoreBoard } from "./board";
import { checkStillOpen } from "./check-open";
import { createChat } from "./chat";
import { createHandoffs, HANDOFF_LIMIT_MS, type HandoffAnswer } from "./handoff";
import { installJobHooks } from "./hooks";
import { openPhase } from "./phase";
import { createPageReading } from "./read-page";
import { apiReader } from "./readers/api";
import { browserReader, tabPage } from "./readers/browser";
import { textReader } from "./readers/text";
import type { PageReader } from "./readers/types";
import { visualReader } from "./readers/visual";
import { createRoleRunner, Halt } from "./run-role";
import { createScanner, SCAN_LIMITS, type SearchFn } from "./scan";
import { createJobState, JobError } from "./state";
import { createJobTeam } from "./team";

const STOP_WAIT_MS = 5000;

/**
 * Job Bots: interview you, then find and check jobs that fit you when you start a scan. This file only wires the
 * modules together; the logic is in @mrog/jobs and the files next to this one.
 */
export function installJobs(services: Services) {
  const { bus, browser } = services;
  const state = createJobState(services);
  const team = createJobTeam(services, state);
  const roles = createRoleRunner(services, state, team);

  /** The outside world: replaceable in tests (saved pages instead of the web). */
  const io = {
    readers: {
      api: apiReader(services.fetchImpl),
      text: textReader(services.fetchImpl),
      browser: browserReader(browser),
      visual: visualReader(browser, state, roles, services),
    } as Partial<Record<Exclude<JobReader, "you">, PageReader>>,
    /** Searches in the Job Bot's own tab (or the search service set in Settings → Browser). */
    // The title each result showed goes along: the scan ranks postings of jobs you want first, and drops others.
    search: (async (botId, query, signal) =>
      (await browser.searchResults(botId, query, signal))?.map((result) => ({
        url: result.url,
        ...(result.title ? { title: result.title } : {}),
      })) ?? null) as SearchFn,
    reread: (botId: string) => tabPage(browser, botId, "you"),
    show: async (botId: string, url: string) => {
      await browser.goto(botId, url);
      if (browser.settings().show) await browser.focus(botId);
    },
    limits: SCAN_LIMITS,
    handoffLimitMs: HANDOFF_LIMIT_MS,
  };
  const handoffs = createHandoffs(() => io.handoffLimitMs);
  const reading = createPageReading({
    state,
    get readers() {
      return io.readers;
    },
    handoffs,
    reread: (botId) => io.reread(botId),
    show: (botId, url) => io.show(botId, url),
  });
  const scanner = createScanner({
    state,
    roles,
    reading,
    search: (botId, query, signal) => io.search(botId, query, signal),
    get limits() {
      return io.limits;
    },
  });

  const runs = new Map<string, { controller: AbortController; done: Promise<void> }>();

  /** The scan's closing words: why it ended and the strongest new matches. */
  const summary = (project: JobProject, reason: string) => {
    const fresh = project.cards.filter((card) => card.scan === project.scan?.number);
    const matches = fresh.filter((card) => isGoodMatch(card.score));
    const good = matches.toSorted((a, b) => b.score - a.score).slice(0, 5);
    const weaker = fresh.length - matches.length;
    const also =
      weaker > 0
        ? `\n\n${weaker} weaker match${weaker === 1 ? "" : "es"} also went on the board, not counted.`
        : "";
    if (good.length === 0) return `${reason}${also}`;
    const lines = good.map(
      (card) =>
        `- ${factValue(card.facts, "title")} at ${factValue(card.facts, "company")}: ${card.score} (${scoreLabel(card.score)})`,
    );
    return `${reason}\n\nStrongest new matches:\n${lines.join("\n")}${also}\n\nThey're on the board.`;
  };

  const startScan = (botId: string, target: number) => {
    const project = state.need(botId);
    if (runs.has(botId)) throw new JobError("A scan is already running.", "wrong_state", 409);
    if (project.status === "interview" || project.status === "awaiting_profile")
      throw new JobError(
        "Approve your profile first: the scan searches for what it says.",
        "wrong_state",
        409,
      );
    const missing = missingForApproval(project.profile);
    if (missing.length > 0)
      throw new JobError(`Your profile still needs ${missing.join(" and ")}.`, "wrong_state", 409);
    const controller = new AbortController();
    state.change(botId, (p) => {
      p.status = "scanning";
      p.askingCount = false;
      p.error = null;
      p.note = null;
    });
    const phase = openPhase(services, botId, "Starting a scan…");
    const done = (async () => {
      let closing = "Scan stopped.";
      try {
        if (!phase) throw new Halt();
        closing = summary(state.need(botId), await scanner(botId, target, controller.signal, phase));
      } catch (error) {
        if (!(error instanceof Halt) && !controller.signal.aborted) {
          const failed = `The scan failed: ${(error as Error).message}`;
          closing = failed;
          state.change(botId, (p) => {
            p.error = closing;
            // The scan has ended, failed: its card and the status line say so instead of looking unfinished.
            if (p.scan && !p.scan.endedAt)
              Object.assign(p.scan, { endedAt: state.now(), stopReason: failed });
            state.logLine(p, failed);
          });
          // What it found before it failed is on the board: said, so it isn't missed.
          closing = summary(state.need(botId), failed);
        } else {
          state.change(botId, (p) => {
            if (p.scan && !p.scan.endedAt)
              Object.assign(p.scan, { endedAt: state.now(), stopReason: "You stopped it." });
            state.logLine(p, "Scan stopped");
          });
          // The jobs found before Stop are on the board: the closing words say which, as for a scan that finished.
          const now = state.load(botId);
          if (now) closing = summary(now, "Scan stopped.");
        }
      } finally {
        runs.delete(botId);
        state.change(botId, (p) => {
          p.status = p.error ? "error" : "ready";
          p.active = null;
          p.handoff = null;
        });
        phase?.close(closing, controller.signal.aborted ? "stopped" : "done");
      }
    })();
    runs.set(botId, { controller, done });
    return structuredClone(state.need(botId));
  };

  /**
   * Checks whether the board's Found and Shortlisted jobs are still open, when you press Check: the cheap readers and no
   * model, never on a timer. Not while a scan runs (it reads with the same tab and limits).
   */
  const checkOpen = (botId: string) => {
    const project = state.need(botId);
    if (runs.has(botId))
      throw new JobError("Wait for the scan to end, or stop it first.", "wrong_state", 409);
    if (!project.cards.some((card) => card.column === "found" || card.column === "shortlisted"))
      throw new JobError("There are no jobs in Found or Shortlisted to check.", "wrong_state", 409);
    const controller = new AbortController();
    const phase = openPhase(services, botId, "Checking whether your jobs are still open…");
    state.change(botId, (p) => {
      p.status = "scanning";
      p.note = "Checking whether your jobs are still open";
    });
    const done = (async () => {
      let closing = "Stopped checking.";
      try {
        if (!phase) return;
        const { checked, closed, unreadable } = await checkStillOpen({
          state,
          botId,
          readers: io.readers,
          signal: controller.signal,
          phase,
        });
        // Stopped part way: the closing words say so, not "all still open" for jobs never read.
        closing = controller.signal.aborted
          ? `Stopped checking.${closed > 0 ? ` ${closed} closed so far (marked on the board).` : ""}`
          : `Checked ${checked} job${checked === 1 ? "" : "s"}: ${
              closed === 0 ? "all still open" : `${closed} closed (marked on the board)`
            }${unreadable > 0 ? `; ${unreadable} couldn't be read this way` : ""}.`;
        state.change(botId, (p) => state.logLine(p, closing));
      } catch (error) {
        closing = `The check failed: ${(error as Error).message}`;
        state.change(botId, (p) => state.logLine(p, closing));
      } finally {
        runs.delete(botId);
        state.change(botId, (p) => {
          p.status = p.error ? "error" : "ready";
          p.note = null;
        });
        phase?.close(closing, controller.signal.aborted ? "stopped" : "done");
      }
    })();
    runs.set(botId, { controller, done });
    return structuredClone(state.need(botId));
  };

  const stop = async (botId: string) => {
    const run = runs.get(botId);
    if (run) {
      run.controller.abort();
      await Promise.race([run.done, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS))]);
    }
    return structuredClone(state.need(botId));
  };

  const chat = createChat({
    services,
    state,
    roles,
    startScan: (botId, target) => {
      try {
        startScan(botId, target);
      } catch (error) {
        if (!(error instanceof JobError)) throw error;
        state.say(botId, error.message);
      }
    },
    stop,
  });
  installJobHooks(services, team, roles, chat.hear);

  /** Applies a change to the project and hands back a copy. */
  const edit = (botId: string, fn: (project: JobProject) => void) => {
    state.need(botId);
    return structuredClone(state.change(botId, fn)!);
  };

  const updateProfile = (botId: string, input: UpdateJobProfileInput) =>
    edit(botId, (p) => {
      try {
        p.profile = mergeProfile(p.profile, input);
      } catch (error) {
        throw new JobError(`That profile doesn't fit: ${(error as Error).message}`);
      }
      // The board follows the profile: scores worked out again, by code.
      rescoreBoard(p);
      if (p.status === "interview" && missingForApproval(p.profile).length === 0)
        p.status = "awaiting_profile";
    });

  const approveProfile = (botId: string) => {
    const missing = missingForApproval(state.need(botId).profile);
    if (missing.length > 0)
      throw new JobError(`Your profile still needs ${missing.join(" and ")}.`, "wrong_state", 409);
    const project = edit(botId, (p) => {
      if (p.status === "interview" || p.status === "awaiting_profile") p.status = "ready";
      p.note = null;
      state.logLine(p, "Profile approved");
    });
    state.say(
      botId,
      "Profile approved. Start a scan with the Scan button, or tell me to search: I'll ask how many new jobs to find each time.",
    );
    return project;
  };

  const answerHandoff = (botId: string, action: HandoffAnswer) => {
    if (!handoffs.answer(botId, action))
      throw new JobError("Nothing is waiting for you.", "wrong_state", 409);
    return structuredClone(state.need(botId));
  };

  // Deleting the Job Bot takes its team, its state and its chats with it.
  services.disposers.push(
    bus.subscribe((event) => {
      if (event.type !== "bot.deleted") return;
      const project = state.saved(event.botId);
      if (!project) return;
      runs.get(event.botId)?.controller.abort();
      runs.delete(event.botId);
      state.forget(event.botId);
      team.removeTeam(project);
    }),
  );
  // Saves still waiting go to disk as the app closes. (Disposers run in reverse order: this one after scans stop.)
  services.disposers.push(() => state.flush());
  services.disposers.push(() => {
    for (const run of runs.values()) run.controller.abort();
  });

  return {
    get: (botId: string) => {
      const project = state.load(botId);
      return project ? structuredClone(project) : null;
    },
    create: async (input: CreateJobBotInput) => {
      const made = await team.create(input);
      state.say(
        made.bot.id,
        `Hi, I'm ${made.bot.name}. Tell me about the job you want: the job title, and where you'd like to work (remote, hybrid or office, and which places). I'll ask a few more questions, then you approve your profile and I search when you ask.`,
      );
      return made;
    },
    updateProfile,
    approveProfile,
    startScan,
    checkOpen,
    stop,
    answerHandoff,
    react: (botId: string, cardId: string, input: ReactToJobInput) =>
      edit(botId, (p) => react(p, cardId, input)),
    move: (botId: string, cardId: string, column: JobColumn) =>
      edit(botId, (p) => moveCard(p, cardId, column)),
    answerSuggestion: (botId: string, id: string, accept: boolean) =>
      edit(botId, (p) => {
        answerSuggestion(p, id, accept);
        if (accept) rescoreBoard(p);
      }),
    isTeamBot: team.isTeamBot,
    isTeamThread: team.isTeamThread,
    isRoleBot: (bot: Parameters<typeof team.roleOf>[0]) => team.roleOf(bot) !== null,
    /** The readers, search and limits: tests swap them for saved pages and short limits. */
    io,
    /** Resolves when the bot's current scan has ended (tests). */
    idle: (botId: string) => runs.get(botId)?.done ?? Promise.resolve(),
  };
}

export type Jobs = ReturnType<typeof installJobs>;
