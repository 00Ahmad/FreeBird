import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  AgentSettings,
  ApprovalDecision,
  DEFAULT_AGENT_SETTINGS,
  NewPermissionRule,
  Permissions,
  PlanStepStatus,
  restrictsTools,
  toolAllowed,
  type Bot,
  type AppToolKind,
  type BotTools,
  type Thread,
  type ToolGroup,
  type ToolInfo,
} from "@mrog/shared";
import { BUILTIN_TOOLS, createToolHost, defineTool, safe, type Risk, type ToolSpec } from "@mrog/tools";

import { fail, parse } from "../http";
import type { TurnInfo } from "../turns";
import type { Services } from "../services";
import { VISUAL_BOT_KEEPS, VISUAL_TOOL_NAMES } from "../visual";
import { ApprovalBroker, QuestionBroker, type TurnScope } from "./approvals";

export { ApprovalBroker, QuestionBroker } from "./approvals";

export interface Agent {
  approvals: ApprovalBroker;
  questions: QuestionBroker;
  /**
   * Extra tool sources (memory, bot-to-bot, connectors…). `messageId` is where the turn's cards go: the bot's own
   * message, or for a delegated helper, its coordinator's message (`info.surface`).
   */
  toolSources: ((bot: Bot, thread: Thread, messageId: string, info: TurnInfo) => ToolSpec[])[];
  /** Narrow a turn's tools (e.g. a group discussion keeps only research tools). */
  toolFilters: ((bot: Bot, thread: Thread, specs: ToolSpec[]) => ToolSpec[])[];
  /** Extra prompt sections. */
  promptSources: ((bot: Bot, thread: Thread, info: TurnInfo) => { memory?: string[]; extra?: string[] })[];
  /** Environment variables (granted secrets) for commands a bot runs. */
  envFor?(bot: Bot): Record<string, string>;
  workspaceFor(botId: string): string;
  settings(): AgentSettings;
  saveSettings(next: AgentSettings): AgentSettings;
  /** Every tool the bot would have if its own tool list allowed all of them (what the Details panel offers). */
  listTools(bot: Bot): ToolInfo[];
  /**
   * Limits from outside the bot's own tool list (its coordinator's list, its access to a connected app). Each says
   * why a tool is held off for this bot, or null. The bot's own list is checked separately.
   */
  toolGates: ((bot: Bot, toolName: string) => string | null)[];
  /** Whether the bot may use this tool at all: its own list and every gate. */
  allows(bot: Bot, toolName: string): boolean;
  /** Why the bot may not use this tool, or null when it may. */
  heldBy(bot: Bot, toolName: string): string | null;
  /** Lines for the end of the prompt about limits a gate sets (e.g. "you can only read from Gmail"). */
  limitNotes: ((bot: Bot) => string | null)[];
  /** Takes the user's secret values out of tool results and errors (set once the scrubber exists). */
  scrub?(text: string): string;
  /** For a connected app's tool: the app and what the tool does there (set once connectors exist). */
  describeApp?(toolName: string): { id: string; name: string; kind: AppToolKind } | null;
}

const GROUPS: [RegExp, ToolGroup][] = [
  [/^(list_files|read_file|write_file|edit_file|search_files)$/, "files"],
  [/^run_command$/, "commands"],
  [/^(fetch_url|web_search)$/, "web"],
  [/^(browser_|screen_)/, "browser"],
  [/^computer_/, "computer"],
  [/^(request_secret|use_login)$/, "vault"],
  [/^(spawn_bot|delegate|dismiss_bot|message_bot)$/, "team"],
  [/^(remember|forget)$/, "memory"],
  [/__|^query_result$/, "apps"],
];
export const toolGroup = (name: string): ToolGroup =>
  GROUPS.find(([pattern]) => pattern.test(name))?.[1] ?? "chat";

/** The line that tells a model which of the tools mentioned elsewhere in its prompt it doesn't have. */
export function toolLimitsNote(tools: BotTools): string | null {
  if (!restrictsTools(tools)) return null;
  const parts: string[] = [];
  if (tools.allow !== null)
    parts.push(
      tools.allow.length === 0
        ? "You have no tools in this chat: answer from what you know and what the user tells you."
        : `You may use only these tools: ${tools.allow.join(", ")}.`,
    );
  if (tools.exclude.length > 0)
    parts.push(`These tools are turned off for you and can't be used: ${tools.exclude.join(", ")}.`);
  parts.push(
    "This overrides anything above that says you have a tool: don't try to call one that isn't available. If a job needs one, say so plainly instead of working around it.",
  );
  return parts.join(" ");
}

const SETTINGS_KEY = "agent";

/** The checklist a bot keeps for a task with several steps; the chat shows the latest version. */
const updatePlanTool = defineTool({
  name: "update_plan",
  description:
    "Write or update your checklist for a task with several steps. The user sees it live. Send the whole list every time, each step with its status: todo, doing or done.",
  // Small models often send plain strings, or the list as a JSON string.
  prepare: (args) => {
    let steps: unknown = args.steps ?? args.plan ?? args.items;
    if (typeof steps === "string") {
      const text = steps;
      try {
        steps = JSON.parse(text);
      } catch {
        steps = text.split("\n").filter((line) => line.trim());
      }
    }
    if (Array.isArray(steps)) {
      steps = steps.map((step: unknown) => (typeof step === "string" ? { step, status: "todo" } : step));
    }
    return { steps };
  },
  args: z.object({
    steps: z
      .array(
        z.object({
          step: z.string().trim().min(1).max(200),
          status: PlanStepStatus.default("todo"),
        }),
      )
      .min(1)
      .max(15),
  }),
  risk: () => safe("Update the plan"),
  run: async (args) => {
    const finished = args.steps.filter((step) => step.status === "done").length;
    return finished === args.steps.length
      ? "Plan saved: every step is done. Give the user the result now."
      : `Plan saved (${finished} of ${args.steps.length} done). Go on with the next step.`;
  },
});

const ENVIRONMENT =
  process.platform === "win32"
    ? "This computer runs Windows; commands run in Windows PowerShell 5.1."
    : process.platform === "darwin"
      ? "This computer runs macOS; commands run in sh."
      : "This computer runs Linux; commands run in sh.";

/** Tools by which a coordinator hands work to others and waits: their calls are still "running" while a helper acts. */
const HAND_OFFS = new Set(["delegate", "message_bot"]);

const NO_CARDS_IN_GROUPS =
  "Not available in group chats: this needs the user's approval, and approval cards can't be shown here. Do without it, or tell the user to ask you in your own chat.";
const NO_CARDS_UNATTENDED =
  "Not available to a racer: this needs the user's approval, and racers work on their own with nobody to ask. Do without it, and say in your result what you couldn't do.";

/**
 * Group chats (and racers, whose chats nobody is watching) can't show approval cards. An action that would need one
 * (and isn't already allowed by a rule or the command policy) is answered with the reason, instead of looking like
 * the user denied it.
 */
function withoutCards(spec: ToolSpec, approvals: ApprovalBroker, reason = NO_CARDS_IN_GROUPS): ToolSpec {
  const needsCard = (risk: Risk) => risk.level === "ask" && approvals.settled(spec.name, risk) === undefined;
  return {
    ...spec,
    risk: async (args, ctx) => {
      const risk = await spec.risk(args, ctx);
      return needsCard(risk) ? { ...risk, level: "safe" } : risk;
    },
    run: async (args, ctx) => (needsCard(await spec.risk(args, ctx)) ? reason : spec.run(args, ctx)),
  };
}

/** Gives every turn tools (built-ins + registered sources), approvals and questions. */
export function installAgent(services: Services): Agent {
  const { config, store, bus, turns } = services;
  const approvals = new ApprovalBroker({ store, bus, turns });
  const questions = new QuestionBroker({ turns });
  const agent: Agent = {
    approvals,
    questions,
    toolSources: [],
    toolFilters: [],
    promptSources: [],
    workspaceFor: (botId) => join(config.dataDir, "workspaces", botId),
    settings: () =>
      store.settings.cached(SETTINGS_KEY, (saved) => {
        const parsed = AgentSettings.safeParse({
          ...DEFAULT_AGENT_SETTINGS,
          ...(saved as Partial<AgentSettings> | undefined),
        });
        return parsed.success ? parsed.data : DEFAULT_AGENT_SETTINGS;
      }),
    saveSettings: (next) => {
      store.settings.set(SETTINGS_KEY, next);
      bus.publish({ type: "data.changed", keys: ["agent-settings"] });
      return next;
    },
    listTools: (bot) => listTools(bot),
    toolGates: [],
    limitNotes: [],
    allows: (bot, name) => heldBy(bot, name) === null,
    heldBy: (bot, name) => heldBy(bot, name),
  };

  /** The bot's own list first, then every gate. */
  const heldBy = (bot: Bot, name: string): string | null => {
    if (!toolAllowed(bot.tools, name)) return "switched off in its tool list";
    for (const gate of agent.toolGates) {
      const reason = gate(bot, name);
      if (reason) return reason;
    }
    return null;
  };

  // A helper can't do more than the bot that made it: otherwise a coordinator with a tool switched off could make a
  // helper and hand it the job. Checked through the coordinator's own gates too (its access to connected apps).
  agent.toolGates.push((bot, name) => {
    if (!bot.parentId) return null;
    const parent = store.bots.get(bot.parentId);
    if (!parent || agent.allows(parent, name)) return null;
    return `held off for ${parent.name}, which made this helper`;
  });

  /** The tools a turn of this bot would be offered before the bot's own list is applied. */
  const assemble = (bot: Bot, thread: Thread, messageId: string, info: TurnInfo): ToolSpec[] => {
    const all = [
      ...BUILTIN_TOOLS,
      ...(agent.settings().planning ? [updatePlanTool] : []),
      ...agent.toolSources.flatMap((source) => source(bot, thread, messageId, info)),
    ];
    // A Visual Bot works only from what it sees: no tools that read pages as text or run commands.
    const visible = bot.visual
      ? all.filter((spec) => VISUAL_TOOL_NAMES.has(spec.name) || VISUAL_BOT_KEEPS.has(spec.name))
      : all;
    return agent.toolFilters.reduce((list, filter) => filter(bot, thread, list), visible);
  };

  const listTools = (bot: Bot): ToolInfo[] => {
    const thread = store.threads.get(bot.threadId);
    const offered = thread ? assemble(bot, thread, "preview", { delegated: false }) : [];
    const listed = offered.map((spec): ToolInfo => {
      const app = agent.describeApp?.(spec.name) ?? null;
      const own = toolAllowed(bot.tools, spec.name);
      // Held off from outside the bot's list (its coordinator, its access to an app): no switch here can change that.
      const gate = own ? heldBy(bot, spec.name) : null;
      // Held off by a pattern (`gmail__*`) or by an allow list: the panel only edits exact names in `exclude`.
      const exact = bot.tools.exclude.includes(spec.name);
      const heldByAllow = bot.tools.allow !== null && !toolAllowed({ ...bot.tools, exclude: [] }, spec.name);
      const heldByPattern = !own && !exact && bot.tools.exclude.some((pattern) => pattern.endsWith("*"));
      return {
        name: spec.name,
        description: spec.description,
        group: toolGroup(spec.name),
        enabled: own && gate === null,
        available: true,
        editable: gate !== null ? false : own ? !heldByAllow : exact && !heldByAllow && !heldByPattern,
        heldBy:
          gate ??
          (heldByAllow
            ? "outside its allow list"
            : heldByPattern
              ? "switched off by a pattern in its list"
              : null),
        ...(app ? { app: { id: app.id, name: app.name, kind: app.kind } } : {}),
      };
    });
    // Named in the list but not offered right now (a stopped computer, a disconnected app): still shown, so
    // it can be switched back on.
    const missing = bot.tools.exclude
      .filter((name) => !name.endsWith("*") && !offered.some((spec) => spec.name === name))
      .map((name): ToolInfo => ({
        name,
        description: "Not available right now.",
        group: toolGroup(name),
        enabled: false,
        available: false,
        editable: true,
        heldBy: null,
      }));
    return [...listed, ...missing];
  };

  // Helpers hand their answer to a coordinator that checks it, so only top-level turns check themselves.
  turns.extensions.turnOptions = (bot, _thread, info) => {
    const settings = agent.settings();
    return {
      maxSteps: settings.maxSteps,
      selfCheck: settings.selfCheck && !info.delegated,
      // A Visual Bot makes many small moves; long thinking before each one is what makes it slow.
      ...(bot.visual ? { think: false } : {}),
    };
  };

  turns.extensions.tools = (bot, thread, messageId, signal, info) => {
    // A delegated helper works in its own thread, but its approvals, questions and secret requests appear in
    // the coordinator's message, where the user is looking.
    const surface = info.surface;
    const scope: TurnScope = {
      threadId: surface?.threadId ?? thread.id,
      messageId: surface?.messageId ?? messageId,
      botId: bot.id,
      // Nowhere to show a card in a group chat, or to a racer: both are refused the same way.
      groupChat: surface ? false : thread.kind === "group" || info.unattended === true,
      signal,
      ...(surface ? { asBot: bot.name } : {}),
    };
    const workspace = agent.workspaceFor(bot.id);
    // The bot's own list comes last, so it narrows whatever the app offered for this kind of turn. The host is built
    // from what is left: a tool that is off isn't just hidden, a call to it by name finds nothing to run.
    const specs = assemble(bot, thread, scope.messageId, info)
      .filter((spec) => agent.allows(bot, spec.name))
      .map((spec) =>
        scope.groupChat
          ? withoutCards(spec, approvals, info.unattended ? NO_CARDS_UNATTENDED : NO_CARDS_IN_GROUPS)
          : spec,
      );
    return createToolHost(
      specs,
      {
        workspace,
        botId: bot.id,
        botName: bot.name,
        threadId: thread.id,
        ask: (question, choices) => questions.ask(question, scope, choices),
        // A getter, so every call sees the secrets granted so far: the owner can hand one over in the middle of this
        // very turn (request_secret, use_login) and the command that follows needs it.
        get env() {
          return agent.envFor?.(bot);
        },
      },
      (request) => approvals.decide(request, scope),
      {
        // Marked on this turn's own message and saved before the call starts, so that if the app dies during it,
        // the restart knows it may have happened (see the store's recoverInterrupted).
        scrub: (text) => (agent.scrub ? agent.scrub(text) : text),
        outward: (call) => {
          const hook = turns.partHooks.get(messageId);
          const part = hook?.parts.find((p) => p.type === "tool" && p.callId === call.id);
          if (hook && part?.type === "tool") {
            part.outward = true;
            hook.publish();
          }
          // A helper works in a chat of its own, but the user is looking at the coordinator's message, where all it
          // shows is the hand-off still running. After a crash that has to say "may have happened" too.
          const coordinator =
            surface && surface.messageId !== messageId ? turns.partHooks.get(surface.messageId) : null;
          if (coordinator) {
            let marked = false;
            for (const handedOver of coordinator.parts) {
              if (
                handedOver.type === "tool" &&
                handedOver.status === "running" &&
                HAND_OFFS.has(handedOver.name)
              ) {
                handedOver.outward = true;
                marked = true;
              }
            }
            if (marked) coordinator.publish();
          }
        },
      },
    );
  };

  turns.extensions.promptExtras = (bot, thread, info) => {
    const memory: string[] = [];
    const settings = agent.settings();
    const extra: string[] = [
      `Your own folder for files is ${agent.workspaceFor(bot.id)}. Work there unless the user points you elsewhere. Use tools to act instead of describing what you would do. ${ENVIRONMENT}`,
      "Take facts and numbers only from tool results in this conversation, and say where each came from (a page address or a file). If you couldn't find something, say so plainly instead of guessing.",
      "When you learn something lasting that would have saved you time (a command that works here, a site that needs the browser, how the user likes things), save it with remember.",
    ];
    if (settings.planning) {
      extra.push(
        "For a task with three or more steps, first call update_plan with a short checklist, then work through it and update it as steps finish.",
      );
    }
    for (const source of agent.promptSources) {
      const result = source(bot, thread, info);
      memory.push(...(result.memory ?? []));
      extra.push(...(result.extra ?? []));
    }
    // Last, so it has the final word over the lines above that describe tools this bot may not have. A helper is held
    // to the limits of the bot that made it as well as its own.
    const parent = bot.parentId ? store.bots.get(bot.parentId) : null;
    for (const note of [
      toolLimitsNote(bot.tools),
      parent && toolLimitsNote(parent.tools)
        ? `The bot that made you has limits that apply to you too. ${toolLimitsNote(parent.tools)}`
        : null,
      ...agent.limitNotes.map((limitsOf) => limitsOf(bot)),
    ])
      if (note) extra.push(note);
    return { memory, extra };
  };

  return agent;
}

/** A typed answer, or the choices ticked on a card (up to six options, plus one the user typed). */
const Answer = z.union([
  z.object({ answer: z.string().trim().min(1).max(4000) }),
  z.object({ choices: z.array(z.string().trim().min(1).max(200)).min(1).max(7) }),
]);

export function registerAgentRoutes(app: FastifyInstance, agent: Agent) {
  app.post<{ Params: { id: string } }>("/api/approvals/:id", async (request, reply) => {
    const body = parse(z.object({ decision: ApprovalDecision }), request.body, reply);
    if (!body) return reply;
    if (!agent.approvals.respond(request.params.id, body.decision)) {
      return fail(reply, 410, "expired", "This request is no longer waiting.");
    }
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/questions/:id", async (request, reply) => {
    const body = parse(Answer, request.body, reply);
    if (!body) return reply;
    // Several picks are kept one per line: a choice may have a comma in it.
    const answer = "answer" in body ? body.answer : body.choices.join("\n");
    if (!agent.questions.respond(request.params.id, answer)) {
      return fail(reply, 410, "expired", "This question is no longer waiting.");
    }
    return reply.code(204).send();
  });

  app.get("/api/permissions", async () => ({ permissions: agent.approvals.permissions() }));

  app.put("/api/permissions", async (request, reply) => {
    const body = parse(Permissions, request.body, reply);
    if (!body) return reply;
    return { permissions: agent.approvals.savePermissions(body) };
  });

  app.post("/api/permissions/rules", async (request, reply) => {
    const body = parse(NewPermissionRule, request.body, reply);
    if (!body) return reply;
    return reply.code(201).send({ rule: agent.approvals.addRule(body) });
  });

  app.delete<{ Params: { id: string } }>("/api/permissions/rules/:id", async (request, reply) => {
    const current = agent.approvals.permissions();
    const rules = current.rules.filter((rule) => rule.id !== request.params.id);
    if (rules.length === current.rules.length) return fail(reply, 404, "not_found", "No rule has this id.");
    agent.approvals.savePermissions({ ...current, rules });
    return reply.code(204).send();
  });

  app.get("/api/agent-settings", async () => ({ settings: agent.settings() }));

  app.put("/api/agent-settings", async (request, reply) => {
    const body = parse(AgentSettings, request.body, reply);
    if (!body) return reply;
    return { settings: agent.saveSettings(body) };
  });

  app.get<{ Params: { id: string } }>("/api/bots/:id/workspace", async (request) => ({
    path: agent.workspaceFor(request.params.id),
  }));
}
