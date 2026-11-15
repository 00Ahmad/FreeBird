import { isGoodLead, leadsCsv, mergeOffer, missingForScan, scoreLabel } from "@mrog/clients";
import {
  type ClientKeyName,
  type ClientProject,
  type CreateClientBotInput,
  type JobReader,
  type LeadColumn,
  type LeadKind,
  type ListEntry,
  type ListName,
  type LookalikeProfile,
  type ReactToLeadInput,
  type UpdateOfferInput,
} from "@mrog/shared";

import { createHandoffs, HANDOFF_LIMIT_MS, type HandoffAnswer } from "../jobs/handoff";
import { openPhase } from "../jobs/phase";
import { apiReader } from "../jobs/readers/api";
import { browserReader, tabPage } from "../jobs/readers/browser";
import { textReader } from "../jobs/readers/text";
import type { PageReader } from "../jobs/readers/types";
import type { Services } from "../services";
import {
  addLead,
  addLines,
  answerSuggestion,
  forgetLead,
  moveLead,
  reactToLead,
  removeEntry,
  setNote,
  setWatch,
} from "./board";
import { createChat } from "./chat";
import { createFinder, type SearchFn } from "./finder";
import { installClientHooks } from "./hooks";
import { learnLookalikes } from "./lookalikes";
import { createPageReading } from "./read-page";
import { createRegisters, fetchJson, KEY_NAMES, type FetchJson } from "./registers";
import { createRoleRunner, Halt } from "./run-role";
import { createScanner, SCAN_LIMITS } from "./scan";
import { ClientError, createClientState } from "./state";
import { createClientTeam } from "./team";
import { visualReader } from "./visual-reader";

const STOP_WAIT_MS = 5000;
const KINDS: LeadKind[] = ["asking", "signs", "quiet"];

/**
 * Client Bots: interview you about what you sell, then find and check businesses that may need it when you start a
 * scan. This file only wires the modules together; the logic is in @mrog/clients and the files next to this one.
 */
export function installClients(services: Services) {
  const { bus, browser, vault } = services;
  const state = createClientState(services);
  const team = createClientTeam(services, state);
  const roles = createRoleRunner(services, state, team);

  /** The outside world: replaceable in tests (saved pages and answers instead of the web). */
  const io = {
    readers: {
      api: apiReader(services.fetchImpl),
      text: textReader(services.fetchImpl),
      browser: browserReader(browser),
      visual: visualReader(browser, state, roles),
    } as Partial<Record<Exclude<JobReader, "you">, PageReader>>,
    search: (async (botId, query, signal) =>
      (await browser.searchResults(botId, query, signal))?.map((result) => result.url) ?? null) as SearchFn,
    fetch: fetchJson(services.fetchImpl) as FetchJson,
    reread: (botId: string) => tabPage(browser, botId, "you"),
    show: async (botId: string, url: string) => {
      await browser.goto(botId, url);
      if (browser.settings().show) await browser.focus(botId);
    },
    limits: SCAN_LIMITS,
    handoffLimitMs: HANDOFF_LIMIT_MS,
  };
  const registers = createRegisters(() => ({ vault, fetch: io.fetch }));
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
  const search: SearchFn = (botId, query, signal) => io.search(botId, query, signal);
  const finder = createFinder({ state, roles, reading, search, registers });
  const scanner = createScanner({
    state,
    roles,
    finder,
    registers,
    search,
    get limits() {
      return io.limits;
    },
  });

  const runs = new Map<string, { controller: AbortController; done: Promise<void> }>();

  /** The scan's closing words: why it ended, the strongest new leads, what else happened. */
  const summary = (project: ClientProject, reason: string) => {
    const scan = project.scan;
    const fresh = project.leads.filter((lead) => lead.scan === scan?.number);
    const good = fresh
      .filter((lead) => isGoodLead(lead.score))
      .toSorted((a, b) => b.score - a.score)
      .slice(0, 5);
    const notes: string[] = [];
    const weaker = fresh.length - fresh.filter((lead) => isGoodLead(lead.score)).length;
    if (weaker > 0)
      notes.push(`${weaker} weaker lead${weaker === 1 ? "" : "s"} also went on the board, not counted.`);
    if (scan && scan.movedUp > 0)
      notes.push(
        `${scan.movedUp} watched compan${scan.movedUp === 1 ? "y now shows" : "ies now show"} signs.`,
      );
    if (scan && scan.skipped.length > 0) notes.push(`Skipped: ${scan.skipped.join("; ")}.`);
    const lines = good.map((lead) => `- ${lead.company}: ${lead.score} (${scoreLabel(lead.score)})`);
    return [
      reason,
      lines.length > 0 ? `Strongest new leads:\n${lines.join("\n")}` : "",
      notes.join("\n"),
      lines.length > 0
        ? "They're on the board. They show signs a business may need you, not certainty: check each one."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  };

  const startScan = (botId: string, target: number, kinds?: LeadKind[]) => {
    const project = state.need(botId);
    if (runs.has(botId)) throw new ClientError("A scan is already running.", "wrong_state", 409);
    if (project.status === "interview" || project.status === "awaiting_profile")
      throw new ClientError(
        "Approve your profile first: the scan looks for what it says.",
        "wrong_state",
        409,
      );
    const missing = missingForScan(project.profile);
    if (missing.length > 0)
      throw new ClientError(`Your profile still needs ${missing.join(" and ")}.`, "wrong_state", 409);
    const chosen = kinds && kinds.length > 0 ? KINDS.filter((k) => kinds.includes(k)) : project.lastKinds;
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
        closing = summary(state.need(botId), await scanner(botId, target, chosen, controller.signal, phase));
      } catch (error) {
        if (!(error instanceof Halt) && !controller.signal.aborted) {
          closing = `The scan failed: ${(error as Error).message}`;
          state.change(botId, (p) => {
            p.error = closing;
            state.logLine(p, closing);
          });
        } else
          state.change(botId, (p) => {
            if (p.scan && !p.scan.endedAt)
              Object.assign(p.scan, { endedAt: state.now(), stopReason: "You stopped it." });
            state.logLine(p, "Scan stopped");
          });
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
        if (!(error instanceof ClientError)) throw error;
        state.say(botId, error.message);
      }
    },
    stop,
  });
  installClientHooks(services, team, roles, chat.hear);

  const edit = (botId: string, fn: (project: ClientProject) => void) => {
    state.need(botId);
    return structuredClone(state.change(botId, fn)!);
  };

  /** Changes that read or change your lists and the board can't run during a scan: it writes them too. */
  const idleEdit = (botId: string, fn: (project: ClientProject) => void) => {
    if (runs.has(botId))
      throw new ClientError("Wait for the scan to end, or stop it first.", "wrong_state", 409);
    return edit(botId, fn);
  };

  const updateProfile = (botId: string, input: UpdateOfferInput) =>
    idleEdit(botId, (p) => {
      try {
        p.profile = mergeOffer(p.profile, input);
      } catch (error) {
        throw new ClientError(`That profile doesn't fit: ${(error as Error).message}`);
      }
      if (p.status === "interview" && missingForScan(p.profile).length === 0) p.status = "awaiting_profile";
    });

  const approveProfile = (botId: string) => {
    const missing = missingForScan(state.need(botId).profile);
    if (missing.length > 0)
      throw new ClientError(`Your profile still needs ${missing.join(" and ")}.`, "wrong_state", 409);
    const project = edit(botId, (p) => {
      if (p.status === "interview" || p.status === "awaiting_profile") p.status = "ready";
      p.note = null;
      state.logLine(p, "Profile approved");
    });
    state.say(
      botId,
      "Profile approved. Start a scan with the Scan button, or tell me to find clients: I'll ask how many new leads to find each time.",
    );
    return project;
  };

  const answerHandoff = (botId: string, action: HandoffAnswer) => {
    if (!handoffs.answer(botId, action))
      throw new ClientError("Nothing is waiting for you.", "wrong_state", 409);
    return structuredClone(state.need(botId));
  };

  const setLookalikes = async (botId: string, text: string) => {
    state.need(botId);
    if (runs.has(botId))
      throw new ClientError("Wait for the scan to end, or stop it first.", "wrong_state", 409);
    if (!registers.hasKey("companiesHouse"))
      throw new ClientError(
        "Lookalikes use Companies House: add its API key in the Client Bot's settings first.",
        "key_missing",
        409,
      );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const learned = await learnLookalikes(registers, text, new Date(), controller.signal);
      return edit(botId, (p) => {
        p.lookalikes = { clients: learned.clients, profile: learned.profile, approved: false };
        // Your favourite clients are clients: never shown as leads.
        addLines(p, "clients", text);
        state.logLine(p, learned.note);
      });
    } catch (error) {
      throw new ClientError(`Couldn't look up your clients: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  };

  const updateLookalike = (botId: string, profile: Partial<LookalikeProfile>, approved: boolean) =>
    idleEdit(botId, (p) => {
      if (!p.lookalikes.profile)
        throw new ClientError("Add your favourite clients first.", "wrong_state", 409);
      p.lookalikes.profile = { ...p.lookalikes.profile, ...profile };
      p.lookalikes.approved = approved;
    });

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
  services.disposers.push(() => {
    for (const run of runs.values()) run.controller.abort();
  });

  return {
    get: (botId: string) => {
      const project = state.load(botId);
      return project ? structuredClone(project) : null;
    },
    create: async (input: CreateClientBotInput) => {
      const made = await team.create(input);
      state.say(
        made.bot.id,
        `Hi, I'm ${made.bot.name}. Tell me what you sell and who your ideal client is: their industry, where they are, and roughly how big. I'll ask a few more questions, then you approve your profile and I look for businesses that may need you when you ask.`,
      );
      return made;
    },
    updateProfile,
    approveProfile,
    startScan,
    stop,
    answerHandoff,
    react: (botId: string, leadId: string, input: ReactToLeadInput) =>
      edit(botId, (p) => reactToLead(p, leadId, input)),
    move: (botId: string, leadId: string, column: LeadColumn) =>
      edit(botId, (p) => moveLead(p, leadId, column)),
    note: (botId: string, leadId: string, note: string) => edit(botId, (p) => setNote(p, leadId, note)),
    watch: (botId: string, leadId: string, watch: boolean) => edit(botId, (p) => setWatch(p, leadId, watch)),
    forget: (botId: string, leadId: string, block: boolean) =>
      idleEdit(botId, (p) => forgetLead(p, leadId, block)),
    answerSuggestion: (botId: string, id: string, accept: boolean) =>
      edit(botId, (p) => answerSuggestion(p, id, accept)),
    addToList: (botId: string, list: ListName, text: string) =>
      idleEdit(botId, (p) => {
        const n = addLines(p, list, text);
        state.logLine(
          p,
          `Added ${n} compan${n === 1 ? "y" : "ies"} to your ${list === "doNotContact" ? "do-not-contact" : list} list`,
        );
      }),
    removeFromList: (botId: string, list: ListName, entry: ListEntry) =>
      idleEdit(botId, (p) => removeEntry(p, list, entry)),
    setLookalikes,
    updateLookalike,
    setWatchList: (botId: string, off: boolean) => edit(botId, (p) => void (p.watchOff = off)),
    exportCsv: (botId: string) => leadsCsv(state.need(botId).leads),
    /** Which register keys are saved (never the keys themselves). */
    keys: () => ({ companiesHouse: registers.hasKey("companiesHouse") }),
    setKey: (name: ClientKeyName, key: string) => {
      if (key) vault.set(KEY_NAMES[name], key);
      else vault.delete(KEY_NAMES[name]);
      bus.publish({ type: "secrets.changed", names: vault.names() });
      return { companiesHouse: registers.hasKey("companiesHouse") };
    },
    isTeamBot: team.isTeamBot,
    isTeamThread: team.isTeamThread,
    isRoleBot: (bot: Parameters<typeof team.roleOf>[0]) => team.roleOf(bot) !== null,
    io,
    idle: (botId: string) => runs.get(botId)?.done ?? Promise.resolve(),
    /** Tests: put a lead straight on the board. */
    addLead: (botId: string, lead: Parameters<typeof addLead>[1]) => edit(botId, (p) => addLead(p, lead)),
  };
}

export type Clients = ReturnType<typeof installClients>;
