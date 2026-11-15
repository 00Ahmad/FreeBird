import { z } from "zod";

import {
  BotName,
  isCoordinator,
  messageText,
  ModelRef,
  type Bot,
  type Message,
  type Thread,
} from "@mrog/shared";
import { defineTool, safe, type ToolContext, type ToolSpec } from "@mrog/tools";

import type { Services } from "./services";
import type { Surface } from "./turns";

const MAX_PARALLEL_TASKS = 5;
const MAX_HELPERS = 6;
const HELPERS_SECTION = "Helpers";
/** Longest earlier answer attached to a task with include_results_from. */
const MAX_PASSED_ON = 12_000;
/** Tools that look something up: several of these from a coordinator usually means several parts of one job. */
const LOOKUP_TOOLS = new Set(["web_search", "fetch_url", "browser_open", "screen_go_to"]);
/** Lookups a coordinator makes itself before it's reminded that helpers could take the parts. */
const SPLIT_REMINDER_AFTER = 3;
/** Shorter messages are greetings or quick questions: no need to ask whether they split into parts. */
const MIN_PLAN_WORDS = 8;
/** The user already asked for helpers; the coordinator's prompt covers that. */
const ASKS_FOR_HELPERS = /\b(sub-?agents?|helpers?|workers?|agents?|spawn|delegate)\b/i;
const PLAN_SYSTEM = [
  "You plan work for a coordinator bot. It can do a job itself, or give parts of it to helper bots that work at the same time and report back; the coordinator then combines their answers (a final table, comparison, summary or recommendation is the coordinator's own job and never counts as a part).",
  "Split the job when it covers 2 to 5 separate things that each need their own research: one part per product, option, framework, company, city, source or site. Reply with one line per part, each starting with '- ' and saying that part as a short, complete task.",
  `Example: "Compare the prices of the iPhone 16, Pixel 9 and Galaxy S25 on their makers' sites" becomes:\n- Find the iPhone 16's price on apple.com\n- Find the Pixel 9's price on store.google.com\n- Find the Galaxy S25's price on samsung.com`,
  "Don't split a quick question, a conversation, explaining or writing something from what you already know, a single lookup about one thing (even with several details), work on files in the coordinator's folder (helpers can't see them), or steps that each need the one before (write code, then test it). For those, reply with exactly: ONE",
].join("\n\n");

/** The parts a planning reply lists (none when the job is one thing). */
export function parsePlan(reply: string): string[] {
  return reply
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .split("\n")
    .flatMap((line) => /^\s*(?:[-*•]|\d+[.)])\s+(.+\S)\s*$/.exec(line)?.[1] ?? [])
    .slice(0, MAX_PARALLEL_TASKS);
}

const SPLIT_REMINDER =
  "\n\n(You've now made several separate lookups yourself. If this job has independent parts (one per product, option, source or site), stop doing them one by one: create a helper for each remaining part with spawn_bot, give them all their tasks in one delegate call, then combine their answers with what you already found. If it's really one thing, carry on.)";

/**
 * Bots handing work to bots. Anyone can `message_bot` a teammate; coordinators (the primary bot, or bots you mark)
 * can also create helpers (`spawn_bot`), give several bots tasks at once (`delegate`) and remove helpers
 * (`dismiss_bot`). A bot working on a handed-over task gets none of these tools, so delegation never chains or
 * loops; stopping the coordinator stops its helpers; and a helper's approvals and questions appear in the
 * coordinator's chat.
 */
export function installDelegation(services: Services) {
  const { store, bus, turns, agent, registry, runtime } = services;

  /** Only threads the app made for two bots: never a group chat of the user's that happens to have two members. */
  const findPair = (a: Bot, b: Bot) =>
    store.threads
      .list()
      .find(
        (thread) =>
          thread.pair &&
          thread.memberIds.length === 2 &&
          thread.memberIds.includes(a.id) &&
          thread.memberIds.includes(b.id),
      );

  /** The conversation two bots share; created on first use and listed like any group. */
  const pairThread = (a: Bot, b: Bot): Thread => {
    const existing = findPair(a, b);
    if (existing) return existing;
    const created = store.threads.createGroup(`${a.name} ↔ ${b.name}`, [a.id, b.id], { pair: true });
    bus.publish({ type: "thread.created", thread: created });
    return created;
  };

  /**
   * Teammates a bot can hand work to: visible bots, plus its own helpers even when hidden; never a cluster's experts,
   * and never a Coding Bot or a Job Bot (they run no model turn: each is spoken to in its own chat).
   */
  const teammatesOf = (bot: Bot) =>
    store.bots
      .list()
      .filter(
        (other) =>
          other.id !== bot.id &&
          !other.clusterId &&
          !other.coding &&
          !other.job &&
          !other.client &&
          (!other.hidden || other.parentId === bot.id),
      );

  /** A name without case, spacing or punctuation, so "research_bot" is the bot called "Research Bot". */
  const squash = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

  /** The teammates a name points at: the same name in any case, or failing that the same letters and digits. */
  const teammatesNamed = (from: Bot, name: string): Bot[] => {
    const mates = teammatesOf(from);
    const exact = mates.filter((mate) => mate.name.toLowerCase() === name.trim().toLowerCase());
    if (exact.length > 0) return exact;
    const wanted = squash(name);
    return wanted ? mates.filter((mate) => squash(mate.name) === wanted) : [];
  };

  /** One teammate by name, or a message the model can act on. */
  const resolve = (from: Bot, name: string): Bot | string => {
    const mates = teammatesOf(from);
    const matches = teammatesNamed(from, name);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1)
      return `More than one teammate is called "${name}". Ask the user which one, or rename one.`;
    return `No teammate is called "${name}". Teammates: ${mates.map((mate) => mate.name).join(", ") || "none"}.`;
  };

  /** Hands one task to one bot and waits for its answer. Throws if the caller was stopped. */
  const hand = async (
    from: Bot,
    target: Bot,
    task: string,
    ctx: ToolContext,
    surface: Surface,
  ): Promise<Message> => {
    const thread = pairThread(from, target);
    if (turns.isRunning(thread.id, target.id))
      throw new Error(`${target.name} is still busy with an earlier task.`);
    const sent = store.messages.create({
      threadId: thread.id,
      role: "bot",
      botId: from.id,
      parts: [{ type: "text", text: task }],
    });
    bus.publish({ type: "message.created", message: sent });
    // Each of the helper's model calls waits for the shared model like anyone's: the caller holds no slot while
    // it waits here, so helpers of a local or a cloud bot queue alike, however many run at once.
    const reply = await turns.start(thread, target, "routine", {
      parentSignal: ctx.signal,
      delegated: true,
      surface,
    });
    if (ctx.signal.aborted) throw new Error("Stopped.");
    return reply;
  };

  const answerOf = (target: Bot, reply: Message) => {
    if (reply.status === "done") return messageText(reply).trim() || "(no text)";
    const error = reply.parts.find((part) => part.type === "error");
    return `(${target.name} couldn't finish: ${error?.type === "error" ? error.message : reply.status})`;
  };

  /** The latest answer `source` gave `from`, to pass on to the next helper in a pipeline. */
  const lastAnswer = (from: Bot, source: Bot): string | null => {
    const thread = findPair(from, source);
    const reply = thread
      ? store.messages
          .list(thread.id, { limit: 20 })
          .findLast((message) => message.role === "bot" && message.botId === source.id)
      : undefined;
    if (!reply) return null;
    const answer = answerOf(source, reply);
    return answer.length > MAX_PASSED_ON ? `${answer.slice(0, MAX_PASSED_ON)}\n…(cut)` : answer;
  };

  /** A task with the answers it builds on attached, or a message the model can act on. */
  const withResults = (from: Bot, task: { task: string; include_results_from?: string[] }) => {
    let text = task.task;
    for (const name of task.include_results_from ?? []) {
      const source = resolve(from, name);
      if (typeof source === "string") return source;
      const answer = lastAnswer(from, source);
      if (answer === null)
        return `${source.name} hasn't answered you yet, so there are no results to pass on.`;
      text += `\n\n--- Results from ${source.name} ---\n${answer}`;
    }
    return { text };
  };

  /** A temporary helper of a coordinator, or why it can't be made. */
  const createHelper = (
    bot: Bot,
    input: { name: string; instructions: string; model?: string; visual?: boolean },
  ): Bot | string => {
    const name = BotName.safeParse(input.name);
    if (!name.success) return `"${input.name.slice(0, 60)}" can't be a bot's name. Use a short name.`;
    const helpers = store.bots.list().filter((other) => other.parentId === bot.id && other.temporary);
    if (helpers.length >= MAX_HELPERS) {
      return `You already have ${helpers.length} helpers (${helpers.map((h) => h.name).join(", ")}). Dismiss one with dismiss_bot first.`;
    }
    if (store.bots.list().some((other) => other.name.toLowerCase() === name.data.toLowerCase())) {
      return `A bot called "${name.data}" already exists. Pick another name.`;
    }
    let model: string | null = null;
    if (input.model) {
      const parsed = ModelRef.safeParse(input.model);
      if (!parsed.success || !registry.get(parsed.data.split(":")[0]!)) {
        return `"${input.model}" isn't an available model. Leave model out to use the shared one.`;
      }
      model = parsed.data;
    }
    const helper = store.bots.create(
      {
        name: name.data,
        label: `${input.visual ? "Visual helper" : "Helper"} of ${bot.name}`,
        instructions: input.instructions,
        model,
        visual: input.visual ?? false,
      },
      { parentId: bot.id, temporary: true, section: HELPERS_SECTION },
    );
    bus.publish({ type: "bot.created", bot: helper });
    const own = store.threads.get(helper.threadId);
    if (own) bus.publish({ type: "thread.created", thread: own });
    // Every helper has its conversation with its coordinator from the moment it exists, so it is listed and can be
    // opened even if the coordinator never gives it work (it is empty until then).
    pairThread(bot, helper);
    return helper;
  };

  /** `spawn_bot`: a coordinator makes a helper for part of a job. */
  const spawnTool = (bot: Bot) =>
    defineTool({
      name: "spawn_bot",
      description: `Create a helper bot for part of a job, with its own instructions (and optionally its own model). Use helpers whenever a job splits into independent parts (several products, options, sources or sites); you don't need the user to ask. Set visual for a helper that browses only by looking at the screen. Then give it work with delegate. You can have up to ${MAX_HELPERS} helpers.`,
      args: z.object({
        name: z.string().trim().min(1).max(40),
        instructions: z
          .string()
          .trim()
          .min(1)
          .max(4000)
          .describe("What this helper is for and how it should work"),
        model: z.string().optional().describe("provider:model; leave out to use the shared model"),
        visual: z
          .boolean()
          .optional()
          .describe("true for a Visual Bot that uses the web only by looking at screenshots, like a person"),
      }),
      // Coordinators decide for themselves when a job needs helpers, so making one on the model already in use doesn't
      // ask (the helpers' own risky actions still do). Another model may be a paid API or load a second local model.
      risk: (args) => {
        const summary = `Create helper “${args.name}”: ${args.instructions.slice(0, 160)}`;
        const current = bot.model ?? runtime.settings.sharedModel;
        return !args.model || args.model === current
          ? safe(summary)
          : { level: "ask", kind: "general", badges: [], summary: `${summary} (on ${args.model})` };
      },
      run: async (args) => {
        const made = createHelper(bot, args);
        return typeof made === "string"
          ? made
          : `Created ${made.name}. It does nothing until you give it its task with delegate, so do that next instead of doing its work yourself.`;
      },
    });

  agent.toolSources.push((bot, thread, messageId, info) => {
    // Helpers and bots on a handed-over task never hand work on: one level, no loops.
    if (info.delegated || bot.parentId !== null) return [];
    const surface: Surface = { threadId: info.surface?.threadId ?? thread.id, messageId, botId: bot.id };
    // Group chats can't show approval cards: neither for a helper on another model nor for what helpers do.
    const canSpawn = thread.kind !== "group";
    const mates = teammatesOf(bot);
    const roster = mates.map((mate) => `${mate.name}${mate.label ? ` (${mate.label})` : ""}`).join(", ");
    const tools: ToolSpec[] = [];

    if (mates.length > 0) {
      tools.push(
        defineTool({
          name: "message_bot",
          description: `Send a message to another bot on your team and wait for its reply. Teammates: ${roster}.`,
          args: z.object({ bot_name: z.string().min(1), message: z.string().min(1).max(8000) }),
          risk: (args) => safe(`Message ${args.bot_name}`),
          run: async (args, ctx) => {
            const target = resolve(bot, args.bot_name);
            if (typeof target === "string") return target;
            return `${target.name} replied: ${answerOf(target, await hand(bot, target, args.message, ctx, surface))}`;
          },
        }),
      );
    }

    if (!isCoordinator(bot)) return tools;

    if (canSpawn) tools.push(spawnTool(bot));
    tools.push(
      defineTool({
        name: "delegate",
        // Models often send one task flat ({bot_name, task}) or the list as a JSON string.
        prepare: (args) => {
          let tasks: unknown = args.tasks;
          if (typeof tasks === "string") {
            try {
              tasks = JSON.parse(tasks);
            } catch {
              // left as is: validation explains the problem
            }
          }
          if (tasks && !Array.isArray(tasks) && typeof tasks === "object") tasks = [tasks];
          if (tasks === undefined && typeof args.bot_name === "string" && typeof args.task === "string") {
            tasks = [
              { bot_name: args.bot_name, task: args.task, include_results_from: args.include_results_from },
            ];
          }
          if (Array.isArray(tasks)) {
            tasks = tasks.map((task: unknown) => {
              const from = (task as { include_results_from?: unknown })?.include_results_from;
              if (typeof from === "string") {
                return {
                  ...(task as object),
                  include_results_from: from.split(",").map((name) => name.trim()),
                };
              }
              if (from === null) return { ...(task as object), include_results_from: undefined };
              return task;
            });
          }
          return { tasks };
        },
        description: `Give up to ${MAX_PARALLEL_TASKS} teammates or helpers a task each. They work at the same time; you get all their answers back to combine. Use it on your own whenever a job splits into independent parts. A helper sees only its task, so for a step that builds on earlier answers (checking, auditing, reporting) call delegate again afterwards and list those helpers in include_results_from. Teammates: ${roster || "none yet"}${canSpawn ? " (plus any helpers you create)" : ""}.`,
        args: z.object({
          tasks: z
            .array(
              z.object({
                bot_name: z.string().min(1),
                task: z.string().min(1).max(8000),
                include_results_from: z
                  .array(z.string().min(1))
                  .max(MAX_PARALLEL_TASKS)
                  .optional()
                  .describe("Teammates whose latest answers to you are attached to this task"),
              }),
            )
            .min(1)
            .max(MAX_PARALLEL_TASKS),
        }),
        risk: (args) => safe(`Delegate to ${args.tasks.map((task) => task.bot_name).join(", ")}`),
        run: async (args, ctx) => {
          const targets: Bot[] = [];
          const texts: string[] = [];
          const created: string[] = [];
          for (const task of args.tasks) {
            let target = resolve(bot, task.bot_name);
            // Models often name a helper in delegate without making it first (spawn_bot, then delegate is two steps
            // they skip, and small ones keep retrying the same call). A name nobody has is made here, on the model
            // already in use, which needs no approval either way. Only for a coordinator that may use spawn_bot: with
            // it switched off, this would be a way round that.
            if (
              typeof target === "string" &&
              canSpawn &&
              agent.allows(bot, "spawn_bot") &&
              teammatesNamed(bot, task.bot_name).length === 0
            ) {
              const made = createHelper(bot, {
                name: task.bot_name,
                instructions: `You are a helper made by ${bot.name}. Do each task you're given with your tools, and reply with the result itself.`,
              });
              if (typeof made === "string") return made;
              created.push(made.name);
              target = made;
            }
            if (typeof target === "string") return target;
            if (targets.some((existing) => existing.id === target.id)) {
              return `${target.name} appears twice. Give each bot one task (combine them into one).`;
            }
            const full = withResults(bot, task);
            if (typeof full === "string") return full;
            targets.push(target);
            texts.push(full.text);
          }
          const replies = await Promise.all(
            texts.map((text, index) =>
              hand(bot, targets[index]!, text, ctx, surface).catch((error: Error) => error),
            ),
          );
          if (ctx.signal.aborted) throw new Error("Stopped.");
          const answers = replies
            .map((reply, index) => {
              const target = targets[index]!;
              const answer = reply instanceof Error ? `(${reply.message})` : answerOf(target, reply);
              return `## ${target.name}\n${answer}`;
            })
            .join("\n\n");
          return created.length > 0
            ? `(Created ${created.length === 1 ? "helper" : "helpers"} ${created.join(", ")} for this.)\n\n${answers}`
            : answers;
        },
      }),
      defineTool({
        name: "dismiss_bot",
        description: "Delete a helper you created when you no longer need it (its chats are deleted too).",
        args: z.object({ bot_name: z.string().min(1) }),
        risk: (args) => safe(`Dismiss ${args.bot_name}`),
        run: async (args) => {
          const helper = store.bots
            .list()
            .find(
              (other) =>
                other.parentId === bot.id &&
                other.temporary &&
                other.name.toLowerCase() === args.bot_name.trim().toLowerCase(),
            );
          if (!helper) return `You have no helper called "${args.bot_name}".`;
          removeBot(helper);
          return `Dismissed ${helper.name}.`;
        },
      }),
    );
    return tools;
  });

  /**
   * Deletes a bot (a dismissed helper, or one the user deletes) with its own chat and the bot-to-bot threads it
   * was in. A group chat it was in keeps its other members and its history; one left with nobody goes too.
   */
  const removeBot = (bot: Bot) => {
    turns.stopBot(bot.id);
    const groups = store.threads
      .list()
      .filter((thread) => thread.kind === "group" && thread.memberIds.includes(bot.id));
    store.bots.delete(bot.id);
    bus.publish({ type: "bot.deleted", botId: bot.id });
    bus.publish({ type: "thread.deleted", threadId: bot.threadId });
    for (const thread of groups) {
      if (thread.pair || thread.memberIds.length <= 1) {
        turns.stop(thread.id);
        store.threads.delete(thread.id);
        bus.publish({ type: "thread.deleted", threadId: thread.id });
      } else {
        const left = store.threads.get(thread.id);
        if (left) bus.publish({ type: "thread.updated", thread: left });
      }
    }
  };

  // Small models rarely decide to delegate on their own, but follow a plan that says so. So before a coordinator
  // starts on a real job, its model is asked once whether the job splits into parts; if it does, the turn gets
  // that plan as a note.
  turns.extensions.beforeTurn = async ({ bot, thread, info, latest, tools, ask }) => {
    if (info.delegated || bot.parentId !== null || thread.kind === "group") return null;
    if (!tools.includes("spawn_bot") || !tools.includes("delegate") || latest?.role !== "user") return null;
    const text = messageText(latest).trim();
    if (text.split(/\s+/).length < MIN_PLAN_WORDS || ASKS_FOR_HELPERS.test(text)) return null;
    const parts = parsePlan(await ask(PLAN_SYSTEM, text.slice(-4000)));
    if (parts.length < 2) return null;
    return [
      `(Plan from the app: this job has ${parts.length} independent parts:`,
      ...parts.map((part, index) => `${index + 1}. ${part}`),
      "Create one helper per part with spawn_bot (or reuse helpers you already have), give them all their tasks in one delegate call, then combine their answers into your reply.)",
    ].join("\n");
  };

  // A coordinator that could use helpers but looks things up one by one itself (one search per product, say) gets
  // one reminder after a few lookups. Small models reach for their own tools before they think of delegating.
  agent.toolFilters.push((_bot, _thread, specs) => {
    if (!specs.some((spec) => spec.name === "spawn_bot")) return specs;
    let lookups = 0;
    let handedOut = false;
    return specs.map((spec): ToolSpec => {
      if (spec.name === "delegate")
        return {
          ...spec,
          run: (args, ctx) => {
            handedOut = true;
            return spec.run(args, ctx);
          },
        };
      if (!LOOKUP_TOOLS.has(spec.name)) return spec;
      return {
        ...spec,
        run: async (args, ctx) => {
          const out = await spec.run(args, ctx);
          lookups += 1;
          if (handedOut || lookups !== SPLIT_REMINDER_AFTER) return out;
          return typeof out === "string" ? out + SPLIT_REMINDER : { ...out, text: out.text + SPLIT_REMINDER };
        },
      };
    });
  });

  agent.promptSources.push((bot, thread, info) => {
    if (info.delegated) {
      const from = info.surface ? store.bots.get(info.surface.botId) : null;
      return {
        extra: [
          `You're working on a task ${from?.name ?? "a teammate"} handed you. Do it with your tools and reply with the result itself: complete, concise, no preamble. You can't hand work to other bots.`,
          "Everything you're given is in the task (including other bots' results, if any were attached). Don't search the computer for other bots' work. If the task needs results that weren't attached, or a source gives you nothing usable, say so plainly in your reply instead of guessing.",
        ],
      };
    }
    // These describe tools the bot has to have: a bot whose list turns them off must not be told it can use them.
    if (
      isCoordinator(bot) &&
      bot.parentId === null &&
      thread.kind === "group" &&
      agent.allows(bot, "delegate")
    ) {
      return {
        extra: [
          "You coordinate a team of bots in this app. In a group chat you can't create helpers, but you can give teammates tasks with delegate (they work at the same time) and combine their answers into your reply. Do that on your own, without being asked, when a job splits into independent parts that suit different teammates; answer quick questions yourself. Your reply must contain the actual results, not just a description of what they did.",
        ],
      };
    }
    if (
      isCoordinator(bot) &&
      bot.parentId === null &&
      thread.kind !== "group" &&
      agent.allows(bot, "spawn_bot") &&
      agent.allows(bot, "delegate")
    ) {
      return {
        extra: [
          [
            "You coordinate a team of bots in this app, and you CAN create and run sub-agents: that is what your spawn_bot and delegate tools do.",
            "Before your first tool call, decide for yourself whether the job needs helpers; the user doesn't have to ask. Use them when the job splits into parts that can be done independently and each needs real work with tools: comparing several products, options or sources; gathering facts from several sites or about several items; or doing a task and then having it checked. Work on files in your folder you do yourself: helpers can't see them. One helper per part, 2 to 5 of them.",
            "Do it yourself when it's a quick question, a single lookup or file, a conversation, or steps where each needs the one before. Don't ask the user whether to use helpers, and don't announce that you will: just do it.",
            "When the user asks for sub-agents, helpers, workers or agents, always use them, even when you could do the job alone.",
            "How: 1) call spawn_bot once per helper (a short name and clear instructions), or reuse helpers you already have; 2) call delegate once with a task for each helper; 3) check and combine their answers into your reply.",
            "Helpers see only the task you give them: not this chat, not your files, not each other's work, so put everything a helper needs into its task. Helpers in one delegate call work at the same time. When a step builds on earlier answers (an audit, a report), call delegate again after those finish and name the earlier helpers in include_results_from.",
            "Your reply must contain the actual results (the data, the table, the answer), not just a description of what the helpers did. If they couldn't get something, say so plainly and why.",
            "Never say you can't create sub-agents or bots. Dismiss helpers you won't need again with dismiss_bot.",
          ].join(" "),
        ],
      };
    }
    return {};
  });

  /** Temporary helpers get out of the sidebar once their coordinator's turn is over (they stay reusable). */
  turns.extensions.onTurnEnd = (_thread, bot, _message, info) => {
    if (info.delegated) return;
    for (const helper of store.bots.list()) {
      if (helper.parentId === bot.id && helper.temporary && !helper.hidden) {
        const hidden = store.bots.update(helper.id, { hidden: true });
        if (hidden) bus.publish({ type: "bot.updated", bot: hidden });
      }
    }
  };

  return { removeBot };
}
