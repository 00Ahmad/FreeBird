import type { FastifyInstance } from "fastify";

import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  CreateRaceInput,
  messageText,
  parseModelRef,
  ThreadId,
  type Bot,
  type Message,
  type Race,
  type Racer,
  type Thread,
} from "@mrog/shared";

import {
  clusterTitle,
  DISCUSSION_TOOLS,
  firstNamed,
  keepKnownLinks,
  labelled,
  normalizeUrl,
  URL_PATTERN,
} from "./discussion";
import { fail, parse } from "./http";
import type { Services } from "./services";

/** What a racer may use: research, and files in its own folder. Nothing that waits on the user mid-race. */
export const RACE_TOOLS = new Set([
  ...DISCUSSION_TOOLS,
  "list_files",
  "read_file",
  "write_file",
  "edit_file",
  "search_files",
  "update_plan",
]);
/** Of each racer's answer, at most this much goes to the judge. */
const ANSWER_CHARS = 14_000;
const settingsKey = (threadId: string) => `race:${threadId}`;

const racerInstructions = (task: string, lane: number, lanes: number) =>
  [
    `You are racer ${lane} of ${lanes} in a race. Every racer gets the same task and works alone; none of you sees the others. A judge then compares your results and picks the best, so the quality of your final result is all that counts.`,
    `The task: "${task}"`,
    "First choose your own strategy: the approach you believe gives the best result. Prefer one others might not think of. Write it as the first line of your answer: Strategy: <one sentence>.",
    "Then do the whole task and deliver a complete, polished final result, not a plan of what you would do. Don't ask questions: make reasonable assumptions and state them.",
    "Back facts with sources you opened (give the address). Never invent facts, numbers or sources.",
  ].join("\n\n");

// A fill-in template: small models copy instructions written as prose straight into their answer.
const JUDGE_INSTRUCTIONS = [
  "You are the judge of a race: several AI racers did the same task independently. Be fair and strict, and judge only what they delivered.",
  "Reply with exactly this structure. Replace everything in <angle brackets>; write nothing else.",
  [
    "## Criteria",
    "- <criterion>: <what it means for this task>",
    "<3 to 5 criteria that matter most for this task, such as correctness, completeness, evidence, clarity, originality or practicality>",
    "",
    "## Scores",
    "| Racer | <criterion 1> | <criterion 2> | <…> | Total |",
    "<one row per racer; score each criterion from 1 to 10; Total is the sum of that row>",
    "",
    "Winner: <the racer's name>",
    "",
    "## Why",
    "<two or three sentences: what made the winner best, and what each other racer did well>",
    "",
    "## Final result",
    "<the actual answer to the task, ready to use: what the user asked for, not a review of the racers. Build it from the strongest parts of every racer, and after each part taken from a racer write (from <name>). Use only what the racers produced and your own reasoning; never invent facts or sources. Keep the addresses the racers gave; don't add links of your own. Make it complete, however long that is.>",
  ].join("\n"),
].join("\n\n");

/** The judge's "Winner: <name>" line, matched to a racer: the one named first on it. */
export function parseWinner(text: string, racers: Bot[]): Bot | null {
  const line = labelled(text, "winner");
  return line ? firstNamed(line, racers) : null;
}

interface Live {
  state: Race;
  /** Stop or Judge now pressed: no racer starts or keeps going. */
  ended: "stopped" | "judge" | null;
}

/**
 * Races: 3–5 bots (each on its own model) do the same task at once, each alone in its own thread, then a judge bot
 * picks criteria for the task, scores them, names a winner and compiles the best parts into one result.
 */
export function installRaces(services: Services) {
  const { store, bus, turns, agent, catalog, runtime } = services;
  const live = new Map<string, Live>();

  const publish = (state: Race) => {
    store.settings.set(settingsKey(state.threadId), state);
    bus.publish({ type: "race.updated", race: structuredClone(state) });
  };

  const get = (threadId: string): Race | null => {
    const running = live.get(threadId);
    if (running) return running.state;
    const saved = store.settings.get<Race>(settingsKey(threadId));
    // One that was running when the app closed didn't finish.
    if (saved && (saved.status === "racing" || saved.status === "judging"))
      return {
        ...saved,
        status: "stopped",
        racers: saved.racers.map((racer) =>
          racer.status === "running" || racer.status === "waiting" ? { ...racer, status: "stopped" } : racer,
        ),
      };
    return saved ?? null;
  };

  /** The race a bot is racing or judging in, if any. */
  const raceOf = (bot: Bot): Race | null => {
    if (!bot.clusterId || !store.threads.get(bot.clusterId)?.race) return null;
    return get(bot.clusterId);
  };

  const answerOf = (racer: Racer, bot: Bot): string => {
    const message = racer.messageId ? store.messages.get(racer.messageId) : null;
    const text = message ? messageText(message).trim() : "";
    return text || `(${bot.name} produced no answer: ${racer.status}.)`;
  };

  // Racers keep research and their own files; the judge works from what the racers handed in, with no tools.
  agent.toolFilters.push((bot, _thread, specs) => {
    const race = raceOf(bot);
    if (!race) return specs;
    return race.judgeId === bot.id ? [] : specs.filter((spec) => RACE_TOOLS.has(spec.name));
  });

  const baseOptions = turns.extensions.turnOptions;
  turns.extensions.turnOptions = (bot, thread, info) => {
    const options = baseOptions?.(bot, thread, info) ?? {};
    return raceOf(bot) ? { ...options, selfCheck: false, stepLimitNote: false } : options;
  };

  agent.promptSources.push((bot, thread) => {
    const entry = live.get(thread.id);
    if (!entry || entry.state.judgeId !== bot.id || entry.state.status !== "judging") return {};
    const answers = entry.state.racers.map((racer) => {
      const racerBot = store.bots.get(racer.botId);
      if (!racerBot) return "";
      const model = racerBot.model ?? runtime.settings.sharedModel ?? "the shared model";
      return `### ${racerBot.name} (model: ${model}; ${racer.status})\n${answerOf(racer, racerBot).slice(0, ANSWER_CHARS)}`;
    });
    return {
      extra: [
        `The race's task: "${entry.state.task}"\n\nWhat each racer handed in:\n\n${answers.filter(Boolean).join("\n\n")}`,
        "This group chat's usual advice to keep replies short doesn't apply to you: your final result must be complete.",
      ],
    };
  });

  /**
   * The judge's report with any link the racers didn't give or open taken out (a model filling in plausible-looking
   * addresses); null when nothing changed.
   */
  const keepRacersLinks = (report: Message, racers: Bot[]): Message | null => {
    const known = new Set<string>();
    for (const bot of racers) {
      for (const message of store.messages.list(bot.threadId, { limit: 50 })) {
        if (message.role !== "bot") continue;
        for (const part of message.parts) {
          const text =
            part.type === "text"
              ? part.text
              : part.type === "tool"
                ? `${JSON.stringify(part.args)} ${part.result ?? ""}`
                : "";
          for (const url of text.match(URL_PATTERN) ?? []) known.add(normalizeUrl(url));
        }
      }
    }
    let changed = false;
    const parts = report.parts.map((part) => {
      if (part.type !== "text") return part;
      const text = keepKnownLinks(part.text, known);
      changed ||= text !== part.text;
      return { ...part, text };
    });
    if (!changed) return null;
    const saved = store.messages.update(report.id, { parts });
    if (saved) bus.publish({ type: "message.updated", message: saved });
    return saved;
  };

  const run = async (entry: Live, thread: Thread, racers: Bot[], judge: Bot) => {
    const { state } = entry;
    try {
      await Promise.allSettled(
        racers.map(async (bot, i) => {
          const racer = state.racers[i]!;
          const own = store.threads.get(bot.threadId);
          if (!own || entry.ended) {
            racer.status = "stopped";
            return;
          }
          const prompt = store.messages.create({
            threadId: own.id,
            role: "user",
            parts: [{ type: "text", text: state.task }],
          });
          bus.publish({ type: "message.created", message: prompt });
          racer.status = "running";
          racer.startedAt = new Date().toISOString();
          publish(state);
          const reply = await turns.start(own, bot, "user");
          racer.messageId = reply.id;
          racer.status = reply.status === "done" ? "done" : reply.status === "stopped" ? "stopped" : "error";
          racer.finishedAt = new Date().toISOString();
          publish(state);
        }),
      );
      if (entry.ended === "stopped") {
        state.status = "stopped";
        return;
      }
      const delivered = state.racers.filter((racer) => racer.messageId && racer.status !== "error");
      if (delivered.length === 0) {
        state.status = "error";
        state.error = "No racer handed anything in.";
        return;
      }
      state.status = "judging";
      publish(state);
      let report = await turns.start(store.threads.get(thread.id) ?? thread, judge, "user");
      report = keepRacersLinks(report, racers) ?? report;
      state.reportId = report.id;
      state.winnerId = parseWinner(messageText(report), racers)?.id ?? null;
      state.status = report.status === "done" ? "done" : report.status === "stopped" ? "stopped" : "error";
      if (state.status === "error")
        state.error =
          report.parts.find((part) => part.type === "error")?.message ?? "The judge couldn't finish.";
    } catch (error) {
      console.error("[race] failed", error);
      state.status = "error";
      state.error = (error as Error).message;
    } finally {
      live.delete(thread.id);
      publish(state);
    }
  };

  const start = async (input: CreateRaceInput): Promise<{ thread: Thread; race: Race }> => {
    // Every model must be there before anyone starts, or the race is lopsided from the first second.
    const refs = [...input.racers.map((racer) => racer.model), input.judge.model].map(
      (ref) => ref ?? runtime.settings.sharedModel,
    );
    for (const ref of new Set(refs)) {
      if (!ref)
        throw Object.assign(
          new Error("Pick a model for each bot, or a shared model in Settings → Local model."),
          {
            code: "model_missing",
          },
        );
      if (!(await catalog.info(ref)))
        throw Object.assign(new Error(`The model ${ref} isn't available.`), { code: "model_missing" });
    }

    const draft = store.threads.createGroup(input.title?.trim() || clusterTitle(input.task), [], {
      cluster: true,
      race: true,
    });
    const racers = input.racers.map((entrant, i) =>
      store.bots.create(
        {
          name: entrant.name,
          label: entrant.model ? parseModelRef(entrant.model).model : "Shared model",
          avatar: {
            shape: AVATAR_SHAPES[i % AVATAR_SHAPES.length]!,
            color: AVATAR_COLORS[i % AVATAR_COLORS.length]!,
          },
          model: entrant.model ?? null,
          instructions: racerInstructions(input.task, i + 1, input.racers.length),
        },
        undefined,
        draft.id,
      ),
    );
    const judge = store.bots.create(
      {
        name: "Judge",
        label: "Judge",
        avatar: { shape: "hexagon", color: "slate" },
        model: input.judge.model ?? null,
        instructions: JUDGE_INSTRUCTIONS,
      },
      undefined,
      draft.id,
    );
    const thread = store.threads.update(draft.id, { memberIds: [...racers, judge].map((bot) => bot.id) })!;
    for (const bot of [...racers, judge]) bus.publish({ type: "bot.created", bot });
    bus.publish({ type: "thread.created", thread });
    const note = store.messages.create({
      threadId: thread.id,
      role: "system",
      parts: [
        {
          type: "text",
          text: `Race: ${input.task}\n${racers.map((bot) => bot.name).join(", ")} · judged by the Judge`,
        },
      ],
    });
    bus.publish({ type: "message.created", message: note });

    const state: Race = {
      threadId: thread.id,
      task: input.task,
      racers: racers.map((bot) => ({
        botId: bot.id,
        status: "waiting",
        messageId: null,
        startedAt: null,
        finishedAt: null,
      })),
      judgeId: judge.id,
      status: "racing",
      reportId: null,
      winnerId: null,
      error: null,
      startedAt: new Date().toISOString(),
    };
    const entry: Live = { state, ended: null };
    live.set(thread.id, entry);
    publish(state);
    void run(entry, thread, racers, judge);
    return { thread, race: structuredClone(state) };
  };

  /** Judge now: racers still going stop, and the judge works with what's in. Stop: no judging either. */
  const end = (threadId: string, how: "stopped" | "judge"): boolean => {
    const entry = live.get(threadId);
    if (!entry) return false;
    if (how === "judge" && entry.state.status !== "racing") return false;
    entry.ended = how;
    for (const racer of entry.state.racers) turns.stopBot(racer.botId);
    if (how === "stopped") turns.stopBot(entry.state.judgeId);
    return true;
  };

  bus.subscribe((event) => {
    if (event.type !== "thread.deleted") return;
    end(event.threadId, "stopped");
    store.settings.delete(settingsKey(event.threadId));
  });
  services.disposers.push(() => {
    for (const threadId of live.keys()) end(threadId, "stopped");
  });

  return { get, start, end };
}

export type Races = ReturnType<typeof installRaces>;

export function registerRaceRoutes(app: FastifyInstance, services: Services) {
  const { store, races } = services;

  const raceThread = (raw: string, reply: Parameters<typeof fail>[0]): Thread | undefined => {
    const id = parse(ThreadId, raw, reply);
    if (!id) return undefined;
    const thread = store.threads.get(id);
    if (!thread?.race) {
      void fail(reply, 404, "not_found", "No race has this id.");
      return undefined;
    }
    return thread;
  };

  app.post("/api/races", async (request, reply) => {
    const input = parse(CreateRaceInput, request.body, reply);
    if (!input) return reply;
    const names = input.racers.map((racer) => racer.name.trim().toLowerCase());
    if (new Set(names).size !== names.length || names.includes("judge"))
      return fail(reply, 400, "invalid_request", "Give each racer a different name (and not Judge).");
    try {
      return reply.code(201).send(await races.start(input));
    } catch (error) {
      return fail(
        reply,
        400,
        (error as { code?: string }).code ?? "invalid_request",
        (error as Error).message,
      );
    }
  });

  app.get<{ Params: { id: string } }>("/api/threads/:id/race", async (request, reply) => {
    const thread = raceThread(request.params.id, reply);
    if (!thread) return reply;
    return { race: races.get(thread.id) };
  });

  app.post<{ Params: { id: string } }>("/api/threads/:id/race/judge", async (request, reply) => {
    const thread = raceThread(request.params.id, reply);
    if (!thread) return reply;
    if (!races.end(thread.id, "judge"))
      return fail(reply, 409, "not_racing", "This race isn't running, or the judge has already started.");
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/threads/:id/race/stop", async (request, reply) => {
    const thread = raceThread(request.params.id, reply);
    if (!thread) return reply;
    races.end(thread.id, "stopped");
    return reply.code(204).send();
  });
}
