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
  type Bot,
  type Thread,
} from "@mrog/shared";
import { BUILTIN_TOOLS, createToolHost, defineTool, safe, type Risk, type ToolSpec } from "@mrog/tools";

import { fail, parse } from "../http";
import type { TurnInfo } from "../turns";
import type { Services } from "../services";
import { VISUAL_BOT_KEEPS } from "../visual";
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

const NO_CARDS_IN_GROUPS =
  "Not available in group chats: this needs the user's approval, and approval cards can't be shown here. Do without it, or tell the user to ask you in your own chat.";

/**
 * Group chats can't show approval cards. An action that would need one (and isn't already allowed by a rule or
 * the command policy) is answered with the reason, instead of looking like the user denied it.
 */
function withoutCards(spec: ToolSpec, approvals: ApprovalBroker): ToolSpec {
  const needsCard = (risk: Risk) => risk.level === "ask" && approvals.settled(spec.name, risk) === undefined;
  return {
    ...spec,
    risk: async (args, ctx) => {
      const risk = await spec.risk(args, ctx);
      return needsCard(risk) ? { ...risk, level: "safe" } : risk;
    },
    run: async (args, ctx) =>
      needsCard(await spec.risk(args, ctx)) ? NO_CARDS_IN_GROUPS : spec.run(args, ctx),
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
      groupChat: surface ? false : thread.kind === "group",
      signal,
      ...(surface ? { asBot: bot.name } : {}),
    };
    const workspace = agent.workspaceFor(bot.id);
    const all = [
      ...BUILTIN_TOOLS,
      ...(agent.settings().planning ? [updatePlanTool] : []),
      ...agent.toolSources.flatMap((source) => source(bot, thread, scope.messageId, info)),
    ];
    // A Visual Bot works only from what it sees: no tools that read pages as text or run commands.
    const visible = bot.visual
      ? all.filter(
          (spec) =>
            spec.name.startsWith("screen_") ||
            spec.name.startsWith("browser_") ||
            VISUAL_BOT_KEEPS.has(spec.name),
        )
      : all;
    const filtered = agent.toolFilters.reduce((list, filter) => filter(bot, thread, list), visible);
    const specs = scope.groupChat ? filtered.map((spec) => withoutCards(spec, approvals)) : filtered;
    return createToolHost(
      specs,
      {
        workspace,
        botId: bot.id,
        botName: bot.name,
        threadId: thread.id,
        ask: (question) => questions.ask(question, scope),
        env: agent.envFor?.(bot),
      },
      (request) => approvals.decide(request, scope),
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
    return { memory, extra };
  };

  return agent;
}

const Answer = z.object({ answer: z.string().trim().min(1).max(4000) });

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
    if (!agent.questions.respond(request.params.id, body.answer)) {
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
