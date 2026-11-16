import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  BotId,
  BotName,
  CODING_ROLES,
  CreateCodingBotInput,
  isCodingBusy,
  MAX_CODING_LOG,
  messageText,
  SLOW_CARD_SECONDS,
  ReviseCodingInput,
  UpdateCodingSettingsInput,
  DEFAULT_MAX_ROUNDS,
  type Bot,
  type Avatar,
  type CardWork,
  type CodingCard,
  type CodingEdge,
  type CodingNode,
  type CardComment,
  type CodingProject,
  type CodingRole,
  type Message,
  type MessagePart,
  type Thread,
} from "@mrog/shared";
import type { ChatMessage } from "@mrog/providers";
import { resolvePath, safe, type ToolSpec } from "@mrog/tools";
import { describeRun, detectRun, formatFindings, visualQaMessage, type RunSpec } from "@mrog/visual-qa";

import { beforeYouRun, checkProject, type Finding } from "./coding-check";
import { checkOutputFolder, CodingError } from "./coding-folder";
import { protectedPathReason, secretFileReason } from "./coding-paths";
import {
  alreadyWritten,
  cardsFor,
  filesReady,
  connectorsTouching,
  nextForDeveloper,
  planFromReply,
  readPlanInput,
  reviewable,
  validatePlan,
  zeroWork,
} from "./coding-plan";
import {
  DEVELOPER_MAX_READS,
  DEVELOPER_MAX_STEPS,
  DEVELOPER_STEER_AT,
  developerMessage,
  finalCheckMessage,
  finishCardTool,
  finishCheckTool,
  linkedPaths,
  plannerMessage,
  proposePlanTool,
  qaMessage,
  reviewCardTool,
  ROLE_ALLOWED,
  ROLE_NAMES,
  ROLE_TOOLS,
  VISUAL_QA_TURN_TOOLS,
  roleRules,
  writtenIn,
  type LastTry,
  type TurnCapture,
} from "./coding-tools";
import { fail, parse } from "./http";
import type { Services } from "./services";
import { TurnCancelled, type Surface } from "./turns";
import { stopAllSessions, VisualSession } from "./visual-qa/session";
import { visualQaTools } from "./visual-qa/tools";

const settingsKey = (botId: string) => `coding:${botId}`;
/** A change the user asked for that the Planner hasn't answered yet: saved, so a Stop or a restart doesn't lose it. */
const revisionKey = (botId: string) => `coding-revision:${botId}`;
const TEAM_SECTION = "Coding team";
/** The longest Coding Bot name: its role bots are named after it ("<name> Developer"). */
export const MAX_CODING_NAME = 49;
/** A plan the planner gets wrong is sent back this many times with what was wrong before the project gives up. */
const MAX_PLAN_RETRIES = 3;
/** A Developer or QA turn that ends without finishing its card is tried this many times in all. */
const MAX_TRIES = 3;
/** Model rounds a Visual QA turn gets: starting the app, then a look, a click and a check for each thing it tries. */
const VISUAL_QA_MAX_STEPS = 40;
/** How long Stop waits for the work to wind down before it reports. */
const STOP_WAIT_MS = 5000;

const CODING_AVATAR: Avatar = { shape: "squircle", color: "violet" };
const ROLE_AVATARS: Record<CodingRole, Avatar> = {
  planner: { shape: "diamond", color: "sky" },
  developer: { shape: "hexagon", color: "teal" },
  qa: { shape: "leaf", color: "amber" },
};

/** The work was stopped (Stop, or the bot was deleted): unwinds the loop without an error. */
class Halt extends Error {}
/** The work can't go on: the project stops with this message. */
class Failure extends Error {}
/** A role's turn was stopped from outside the project (Stop or Clear chat in a team thread): the project stops too. */
class StoppedFromTeam extends Error {}

/** A change the user asked for: of a plan that waits for approval, or of a project that was built. */
interface Revision {
  text: string;
  built: boolean;
}

/** Same file on this computer's file system: Windows and macOS don't tell case apart. */
const caseless = process.platform === "win32" || process.platform === "darwin";
// Plans store paths in NFC, so a name typed with combining accents is still the same file.
const fold = (path: string) => {
  const nfc = path.normalize("NFC");
  return caseless ? nfc.toLowerCase() : nfc;
};

const clip = (text: string, length: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};

interface Run {
  controller: AbortController;
  done: Promise<void>;
}

/** The streaming status message of one phase, which is also where the phase's approval cards appear. */
interface Phase {
  surface: Surface;
  say(text: string): void;
  close(text: string, status?: "done" | "stopped"): void;
}

/**
 * Coding Bots: a team of three role bots (Planner, Developer, QA) that plan, write and check a project in an output
 * folder. The loop is plain code: models only do the work inside each step, and the service (not a model) moves the
 * cards. Each step is one turn of a role bot in its pair thread with the Coding Bot, and its approval cards appear in
 * a streaming status message in the Coding Bot's own chat, where the user is looking.
 */
export function installCoding(services: Services) {
  const { store, bus, turns, agent, runtime, catalog, config, delegation, browser } = services;

  /** In-memory projects. The service is the only writer: every change is saved and published whole. */
  const projects = new Map<string, CodingProject>();
  const runs = new Map<string, Run>();
  /** What each role bot's current turn handed back, written by its own tools. */
  const captures = new Map<string, TurnCapture>();
  /** The Visual QA check running for each Coding Bot: what QA's app tools act on. */
  const visualSessions = new Map<string, VisualSession>();
  // Closing FreeBird in the middle of Visual QA still stops the app it started.
  services.disposers.push(() => stopAllSessions());
  /** The output folder of each role bot: their working folder. */
  const folders = new Map<string, string>();
  const now = () => new Date().toISOString();
  /** A comment on a card, with what kind of comment it is (the board shows a fail, a pass and a requeue differently). */
  const comment = (
    author: CardComment["author"],
    kind: NonNullable<CardComment["kind"]>,
    text: string,
    round: number,
  ): CardComment => ({ author, kind, text, round, at: now() });

  // ---- state ------------------------------------------------------------------------------------------------

  /** The change the user asked for that the Planner hasn't answered yet, or null. */
  const revisionOf = (botId: string): Revision | null =>
    store.settings.get<Revision>(revisionKey(botId)) ?? null;
  const setRevision = (botId: string, revision: Revision | null) =>
    revision ? store.settings.set(revisionKey(botId), revision) : store.settings.delete(revisionKey(botId));

  /**
   * What a project interrupted mid-work becomes: a plan that was never approved goes back to waiting for approval, unless
   * the Planner was answering a change the user asked for (then Resume carries on with it).
   */
  const interruptedStatus = (project: CodingProject) =>
    project.status === "planning" && project.cards.length > 0 && !revisionOf(project.botId)
      ? "awaiting_approval"
      : "stopped";

  /**
   * The role bots as the code says they are: the tools of their role (bots made by an older version kept a longer list,
   * which their prompt would still name) and no desktop notifications (every turn of theirs is the loop's, not a reply).
   */
  const syncTeam = (project: CodingProject) => {
    for (const role of CODING_ROLES) {
      const bot = store.bots.get(project.roles[role].botId);
      if (!bot) continue;
      const allow = ROLE_ALLOWED[role];
      const sameTools =
        bot.tools.allow?.length === allow.length && allow.every((name) => bot.tools.allow?.includes(name));
      if (sameTools && !bot.notifications) continue;
      const updated = store.bots.update(bot.id, {
        notifications: false,
        tools: { ...bot.tools, allow: [...allow] },
      });
      if (updated) bus.publish({ type: "bot.updated", bot: updated });
    }
  };

  const adopt = (project: CodingProject) => {
    projects.set(project.botId, project);
    for (const role of CODING_ROLES) folders.set(project.roles[role].botId, project.outputFolder);
    syncTeam(project);
    return project;
  };

  const load = (botId: string): CodingProject | null => {
    const live = projects.get(botId);
    if (live) return live;
    const saved = store.settings.get<CodingProject>(settingsKey(botId));
    if (!saved) return null;
    // One that was working when the app closed didn't finish.
    if (!isCodingBusy(saved.status)) return adopt(saved);
    return adopt({
      ...saved,
      status: interruptedStatus(saved),
      active: null,
      note: "The app closed while the team was working. Resume to carry on.",
      cards: saved.cards.map((card) => (card.column === "in_progress" ? { ...card, column: "todo" } : card)),
    });
  };

  const persist = (project: CodingProject) => {
    store.settings.set(settingsKey(project.botId), project);
    bus.publish({ type: "coding.updated", project: structuredClone(project) });
  };

  /** One short plain-English line for the activity list, keeping the last MAX_CODING_LOG. */
  const logLine = (project: CodingProject, text: string) => {
    project.log = [...(project.log ?? []), { at: now(), text: clip(text, 200) }].slice(-MAX_CODING_LOG);
  };

  /** Changes the project, saves it and publishes it. Null when the project is gone. */
  const change = (botId: string, fn: (project: CodingProject) => void): CodingProject | null => {
    const project = load(botId);
    if (!project) return null;
    fn(project);
    persist(project);
    return project;
  };

  const need = (botId: string): CodingProject => {
    const project = load(botId);
    if (!project) throw new CodingError("This Coding Bot has no project.", "not_found", 404);
    return project;
  };

  const cardOf = (project: CodingProject, id: string) => project.cards.find((card) => card.id === id);

  /** Posts a short message from the Coding Bot in its own chat. */
  const say = (botId: string, text: string): Message | null => {
    const bot = store.bots.get(botId);
    if (!bot) return null;
    const message = store.messages.create({
      threadId: bot.threadId,
      role: "bot",
      botId,
      parts: [{ type: "text", text }],
    });
    bus.publish({ type: "message.created", message });
    return message;
  };

  // ---- the team ---------------------------------------------------------------------------------------------

  /** The coding project a role bot works for, and the role. */
  const roleOf = (bot: Bot): { codingBot: Bot; role: CodingRole } | null => {
    if (!bot.parentId) return null;
    const codingBot = store.bots.get(bot.parentId);
    if (!codingBot?.coding) return null;
    const project = load(codingBot.id);
    const role = project && CODING_ROLES.find((candidate) => project.roles[candidate].botId === bot.id);
    return role ? { codingBot, role } : null;
  };

  const pairOf = (codingBotId: string, roleBotId: string): Thread | undefined =>
    store.threads
      .list()
      .find(
        (thread) =>
          thread.pair &&
          thread.memberIds.length === 2 &&
          thread.memberIds.includes(codingBotId) &&
          thread.memberIds.includes(roleBotId),
      );

  agent.workspaceSources.push((botId) => {
    const known = folders.get(botId);
    if (known) return known;
    const bot = store.bots.get(botId);
    if (!bot?.parentId || !roleOf(bot)) return undefined;
    return folders.get(botId);
  });

  /** The pair thread of a Coding Bot and one of its roles, made again if it was deleted or its members were changed. */
  const ensurePair = (codingBotId: string, roleBot: Bot, role: CodingRole): Thread | undefined => {
    const found = pairOf(codingBotId, roleBot.id);
    if (found) return found;
    const codingBot = store.bots.get(codingBotId);
    if (!codingBot) return undefined;
    const thread = store.threads.createGroup(
      `${codingBot.name} ↔ ${ROLE_NAMES[role]}`,
      [codingBotId, roleBot.id],
      { pair: true },
    );
    bus.publish({ type: "thread.created", thread });
    return thread;
  };

  /** A Coding Bot's conversation with one of its roles. */
  const isTeamThread = (thread: Thread) => {
    if (!thread.pair || thread.memberIds.length !== 2) return false;
    // The shape pairOf looks for; an old thread whose members were changed is no longer one (a new one was made).
    const [a, b] = thread.memberIds.map((id) => store.bots.get(id) ?? undefined);
    const role = (bot: Bot | undefined, coding: Bot | undefined) =>
      !!bot && !!coding?.coding && roleOf(bot)?.codingBot.id === coding.id;
    return role(a, b) || role(b, a);
  };

  /**
   * A path a role names, inside the output folder, as the plan writes paths (forward slashes), or why it isn't one. A
   * segment with ":" (an NTFS alternate data stream) or an 8.3 short name ("SRC~1") is the same file under another
   * name, so comparing names would let it through; such paths are refused rather than worked out.
   */
  const planPathOf = (
    outputFolder: string,
    workspace: string,
    raw: string,
  ): { rel: string } | { problem: string; outside: boolean } => {
    // Only the path as written: one that leads out through a link is the file tools' own check, which asks the user.
    const { abs } = resolvePath(workspace, raw);
    const rel = relative(resolve(outputFolder), abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
      return { problem: "it is outside the output folder", outside: true };
    const segments = rel.split(sep);
    if (segments.some((segment) => segment.includes(":") || /~\d/.test(segment)))
      return {
        problem: 'it is not a plain file path (no ":" and no short names like "SRC~1")',
        outside: false,
      };
    // Windows drops trailing dots and spaces, so "main.js." is main.js.
    if (process.platform === "win32" && segments.some((segment) => /[. ]$/.test(segment)))
      return { problem: "a name in it ends with a dot or a space", outside: false };
    return { rel: segments.join("/") };
  };

  const plannedPath = (project: CodingProject, rel: string) =>
    project.nodes.find((node) => fold(node.path) === fold(rel))?.path;

  /**
   * write_file / edit_file for a role's turn: only the planned files its card may change. A file card writes its own
   * file; a connection, only the files it links. A file outside the plan (a helper, a scratch file, a test script) and a
   * path a role must never write (.git, node_modules, a task runner) are refused, with why.
   */
  const guardWrite = (spec: ToolSpec, codingBotId: string, capture: TurnCapture): ToolSpec => {
    const refusal = (args: Record<string, unknown>, workspace: string): string | null => {
      const project = load(codingBotId);
      const raw = String(args.path ?? "");
      if (!project) return "Not written: the project is gone.";
      const card = capture.card && cardOf(project, capture.card.id);
      const own = capture.card?.path;
      const where = planPathOf(project.outputFolder, workspace, raw);
      if ("problem" in where) return `Not written: ${raw} can't be written because ${where.problem}.`;
      const blocked = protectedPathReason(where.rel);
      if (blocked) return `Not written: ${where.rel} is off limits: ${blocked}.`;
      const planned = plannedPath(project, where.rel);
      const allowed = card?.kind === "file" ? (own ? [own] : []) : card ? linkedPaths(project, card) : [];
      const hint =
        card?.kind === "file"
          ? `In this turn write only ${own}.`
          : card
            ? `This connection may change only the files it links: ${allowed.join(", ")}.`
            : "Nothing may be written outside a card's turn.";
      if (!planned)
        return `Not written: ${where.rel} is not one of the project's planned files. Make no helper, scratch, test or backup files. ${hint}`;
      if (!allowed.some((path) => fold(path) === fold(planned)))
        return card?.kind === "file"
          ? `Not written: ${planned} belongs to another card and is written in its own turn. ${hint}`
          : `Not written: ${planned} is not one of the files this card may change. ${hint}`;
      return null;
    };
    return {
      ...spec,
      // A refused write asks nothing: a path outside the folder would otherwise show the user a card first.
      risk: (args, ctx) =>
        refusal(args as Record<string, unknown>, ctx.workspace)
          ? safe("Refused write")
          : spec.risk(args, ctx),
      run: async (args, ctx) => {
        const refused = refusal(args as Record<string, unknown>, ctx.workspace);
        if (refused) return refused;
        const result = await spec.run(args, ctx);
        // An edit whose text wasn't found changed nothing.
        if (/^(Wrote|Replaced) /.test(typeof result === "string" ? result : result.text))
          capture.wrote = true;
        return result;
      },
    };
  };

  /** Search hits in a file a role may not read are taken out of the result (a hit line starts "path:line: "). */
  const withoutSecretHits = (result: string) =>
    result
      .split("\n")
      .filter((line) => {
        const path = /^(.*?):\d+: /.exec(line)?.[1];
        return !path || !secretFileReason(path);
      })
      .join("\n") || "No matches.";

  /**
   * read_file / search_files for a role's turn. A file that may hold real secrets (.env, a private key) is never read:
   * its text would go to the model. A planned file that isn't written yet is said to be so, instead of an error the
   * model tries again and again. The Developer gets DEVELOPER_MAX_READS distinct files per try, then is told to write.
   */
  const guardRead = (
    spec: ToolSpec,
    codingBotId: string,
    role: CodingRole,
    capture: TurnCapture,
  ): ToolSpec => {
    /** Why this read is refused, or null; `count` adds it to the Developer's reads (the run does, the risk doesn't). */
    const refusal = (args: Record<string, unknown>, workspace: string, count: boolean): string | null => {
      const project = load(codingBotId);
      const raw = String(args.path ?? ".");
      if (!project) return null;
      const where = planPathOf(project.outputFolder, workspace, raw);
      // Another name for a file in the folder (a stream, a short name) could be a secret file's: not read.
      if ("problem" in where && !where.outside)
        return `Not read: ${raw} can't be read because ${where.problem}.`;
      const rel = "rel" in where ? where.rel : raw;
      const secret = secretFileReason(rel);
      if (secret)
        return `Not read: ${rel} is off limits because ${secret}. Don't read it or copy anything from it.`;
      const planned = "rel" in where ? plannedPath(project, where.rel) : undefined;
      // Only the Developer is pointed elsewhere: for QA a planned file that isn't there is a finding.
      if (role === "developer" && planned && !existsAsFile(join(project.outputFolder, planned)))
        return planned === capture.card?.path
          ? `${planned} is not written yet: writing it is this card's job. Write it now with write_file.`
          : `${planned} is not written yet; another card writes it later. Don't read it: use the connection description.`;
      if (role === "developer" && spec.name === "read_file") {
        const reads = (capture.reads ??= []);
        const key = fold(rel);
        if (!reads.includes(key)) {
          if (reads.length >= DEVELOPER_MAX_READS) {
            const own = capture.card?.kind === "file" ? capture.card.path : undefined;
            return own
              ? `You have read enough. Write ${own} now with write_file, then call finish_card.`
              : "You have read enough. Make the edits now with edit_file, then call finish_card.";
          }
          if (count) reads.push(key);
        }
      }
      return null;
    };
    return {
      ...spec,
      risk: (args, ctx) =>
        refusal(args as Record<string, unknown>, ctx.workspace, false)
          ? safe("Refused read")
          : spec.risk(args, ctx),
      run: async (args, ctx) => {
        const refused = refusal(args as Record<string, unknown>, ctx.workspace, true);
        if (refused) return refused;
        const result = await spec.run(args, ctx);
        return spec.name === "search_files" && typeof result === "string"
          ? withoutSecretHits(result)
          : result;
      },
    };
  };

  const existsAsFile = (abs: string) => {
    try {
      return statSync(abs).isFile();
    } catch {
      return false;
    }
  };

  // The roles work in the user's own project folder: their commands always show a card, whatever the command policy
  // or a saved rule says.
  agent.approvals.alwaysAsk.push((botId) => {
    const bot = store.bots.get(botId);
    return !!bot && roleOf(bot) !== null;
  });

  // The Coding Bot has no tools; each role has exactly its own, guarded for the files it may read and write.
  agent.toolFilters.push((bot, _thread, specs) => {
    if (bot.coding) return [];
    const team = roleOf(bot);
    if (!team) return specs;
    // A turn that isn't the loop's (the Details panel listing tools) gets a capture nothing reads.
    const capture = captures.get(bot.id) ?? {};
    const own = new Set([...ROLE_TOOLS[team.role], ...(capture.visual ? VISUAL_QA_TURN_TOOLS : [])]);
    return specs
      .filter((spec) => own.has(spec.name))
      .map((spec) =>
        spec.name === "write_file" || spec.name === "edit_file"
          ? guardWrite(spec, team.codingBot.id, capture)
          : spec.name === "read_file" || spec.name === "search_files"
            ? guardRead(spec, team.codingBot.id, team.role, capture)
            : spec,
      );
  });

  agent.toolSources.push((bot): ToolSpec[] => {
    const team = roleOf(bot);
    if (!team) return [];
    const live = captures.get(bot.id);
    // A turn that isn't the loop's (the Details panel listing tools) gets a capture nothing reads.
    const capture = live ?? {};
    if (team.role === "planner") return [proposePlanTool(capture)];
    if (team.role === "developer") return [finishCardTool(capture)];
    const planned = () => load(team.codingBot.id)?.nodes.map((node) => node.path) ?? [];
    // A card review gets only its verdict, the check of the whole project only its own: a small model offered both
    // sometimes calls the wrong one.
    if (live?.visual) {
      const session = visualSessions.get(team.codingBot.id);
      const folder = load(team.codingBot.id)?.outputFolder ?? "";
      return [
        ...(session ? visualQaTools(browser, bot, session, folder) : []),
        finishCheckTool(capture, planned, "finish_visual_check"),
      ];
    }
    if (live?.finalCheck) return [finishCheckTool(capture, planned)];
    if (live?.card) return [reviewCardTool(capture)];
    return [reviewCardTool(capture), finishCheckTool(capture, planned)];
  });

  agent.promptSources.push((bot) => {
    const team = roleOf(bot);
    const project = team && load(team.codingBot.id);
    return team && project ? { extra: [roleRules(team.role, project.outputFolder)] } : {};
  });

  // The general lines every bot gets that don't fit a role: a checklist tool it doesn't have, memory it has no use for,
  // and for the Developer (which runs nothing) the shell commands run in.
  const ROLE_DROPS = ["save it with remember", "call update_plan"];
  const baseExtras = turns.extensions.promptExtras;
  turns.extensions.promptExtras = (bot, thread, info) => {
    const result = baseExtras?.(bot, thread, info) ?? {};
    const team = roleOf(bot);
    if (!team) return result;
    const extra = (result.extra ?? [])
      .filter((line) => !ROLE_DROPS.some((drop) => line.includes(drop)))
      .map((line) =>
        team.role === "developer" ? line.replace(/\s*This computer runs \w+; commands run in .*$/, "") : line,
      );
    return { ...result, extra };
  };

  /**
   * The Developer's mid-turn note: the engine asks `steer` once per model round for messages to add. When only
   * DEVELOPER_STEER_AT rounds are left and its file isn't written, it is told once to write it now. turnOptions is spread
   * over the turn's own steer, which a role's turn never uses (nobody can message a team thread).
   */
  const developerSteer = (codingBotId: string, capture: TurnCapture) => (): ChatMessage[] => {
    capture.steps = (capture.steps ?? 0) + 1;
    if (capture.steered || capture.steps < DEVELOPER_MAX_STEPS - DEVELOPER_STEER_AT) return [];
    const path = capture.card?.kind === "file" ? capture.card.path : undefined;
    if (!path || capture.wrote || !load(codingBotId)) return [];
    capture.steered = true;
    return [
      {
        role: "user",
        content: `${DEVELOPER_STEER_AT} steps left: write ${path} now with write_file, then call finish_card.`,
      },
    ];
  };

  // A role's turn is a plain task: no self-check pass, and room for a file's worth of tool calls.
  const baseOptions = turns.extensions.turnOptions;
  turns.extensions.turnOptions = (bot, thread, info) => {
    const options = baseOptions?.(bot, thread, info) ?? {};
    const team = roleOf(bot);
    if (!team) return options;
    const plain = { ...options, selfCheck: false, stepLimitNote: false };
    // The Developer's card is one file: no thinking before each move, and a turn that needs more than a handful of
    // rounds is going round in circles (it gets another try, then the project stops).
    if (team.role === "developer") {
      const capture = captures.get(bot.id);
      const steer = capture ? { steer: developerSteer(team.codingBot.id, capture) } : {};
      return { ...plain, think: false, thinkOff: true, maxSteps: DEVELOPER_MAX_STEPS, ...steer };
    }
    if (captures.get(bot.id)?.visual)
      return { ...plain, maxSteps: Math.max(options.maxSteps ?? 0, VISUAL_QA_MAX_STEPS) };
    return { ...plain, maxSteps: Math.max(options.maxSteps ?? 0, 20) };
  };

  // A Coding Bot has no model: nothing starts a model turn for it.
  turns.extensions.refuses = (bot) =>
    bot.coding ? "A Coding Bot runs its team instead of answering with a model." : null;

  // ---- status messages --------------------------------------------------------------------------------------

  /**
   * Opens the streaming status message of a phase in the Coding Bot's chat. It is registered as a part hook, so the
   * approval cards of the turns that use it as their `surface` show up here, in the message the user is watching.
   * The headline is changed in place: replacing the parts would wipe the cards.
   */
  const openPhase = (botId: string, headline: string): Phase => {
    const bot = store.bots.get(botId);
    if (!bot) throw new Halt();
    const message = store.messages.create({
      threadId: bot.threadId,
      role: "bot",
      botId,
      parts: [{ type: "text", text: headline }],
      status: "streaming",
    });
    bus.publish({ type: "message.created", message });
    const parts: MessagePart[] = [{ type: "text", text: headline }];
    let closed = false;
    // What each approval card was last seen as, to put one line in the activity list when it appears and is answered.
    const cards = new Map<string, string>();
    const save = (status?: "done" | "stopped") => {
      const saved = store.messages.update(message.id, {
        parts: structuredClone(parts),
        ...(status ? { status } : {}),
      });
      if (saved) bus.publish({ type: "message.updated", message: saved });
    };
    const noticeCards = () => {
      for (const part of parts) {
        if (part.type !== "tool" || cards.get(part.callId) === part.status) continue;
        const first = !cards.has(part.callId);
        cards.set(part.callId, part.status);
        const what = clip(part.approval?.summary ?? part.args.command?.toString() ?? part.name, 80);
        if (part.status === "pending_approval")
          note(botId, `${part.name} is waiting for your approval: ${what}`);
        // Only the user's answer counts: Stop and the clock close a card too.
        else if (part.decidedBy !== "user" || first) continue;
        else if (part.status === "denied") note(botId, `You denied ${part.name}`);
        else if (part.status === "running" || part.status === "done")
          note(botId, `You approved ${part.name}`);
      }
    };
    turns.partHooks.set(message.id, {
      parts,
      publish: () => {
        if (closed) return;
        noticeCards();
        save();
      },
    });
    return {
      surface: { threadId: bot.threadId, messageId: message.id, botId },
      say(text) {
        if (closed) return;
        (parts[0] as { text: string }).text = text;
        save();
      },
      close(text, status = "done") {
        if (closed) return;
        closed = true;
        turns.partHooks.delete(message.id);
        (parts[0] as { text: string }).text = text;
        // Cards nobody can answer any more.
        for (const part of parts) {
          if (part.type === "tool" && (part.status === "pending_approval" || part.status === "running")) {
            part.status = "error";
            part.result = "Stopped before it finished.";
            delete part.approval;
          }
        }
        save(status);
        // Answering a card marks this chat as working. The Coding Bot runs no turn of its own that would clear it,
        // so when the phase is over, the chat is idle again.
        if (!turns.isBusy(bot.threadId)) turns.setActivity(bot.threadId, null, "idle");
      },
    };
  };

  /** A line in the project's activity list, saved and published. */
  const note = (botId: string, text: string) => change(botId, (project) => logLine(project, text));

  // ---- one role's turn --------------------------------------------------------------------------------------

  /** Clock, slow-card timing and the waits before a failed model is asked again; tests shorten them. */
  const timing = {
    now: () => Date.now(),
    slowSeconds: SLOW_CARD_SECONDS,
    tickMs: 60_000,
    retryBackoffMs: [2000, 10_000],
    /** How long Stop waits for the work to wind down before it reports. */
    stopWaitMs: STOP_WAIT_MS,
  };
  /** Cards already warned about as slow in a round (by role), so the activity list gets one line each. */
  const warned = new Set<string>();

  /** Waits before the next try after a model error: the first wait is short, the next ones longer. Stop ends it. */
  const backoff = (tries: number, signal: AbortSignal) =>
    new Promise<void>((done, stopped) => {
      if (signal.aborted) return stopped(new Halt());
      const waits = timing.retryBackoffMs;
      const ms = waits[Math.min(tries - 1, waits.length - 1)] ?? 0;
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        done();
      }, ms);
      const abort = () => {
        clearTimeout(timer);
        stopped(new Halt());
      };
      signal.addEventListener("abort", abort, { once: true });
    });

  const workOf = (card: CodingCard): CardWork => (card.work ??= zeroWork());
  const minutes = (seconds: number) => {
    const n = Math.max(1, Math.round(seconds / 60));
    return `${n} minute${n === 1 ? "" : "s"}`;
  };

  const errorOf = (reply: Message) =>
    reply.parts.find((part) => part.type === "error")?.message ?? "The model didn't answer.";

  /**
   * Gives a role one task in its pair thread with the Coding Bot and waits for its turn to end. The task carries
   * everything the role needs (the turn reads nothing earlier). Throws Halt when the project is stopped, and
   * StoppedFromTeam when the turn was stopped from its team thread. A model error is handed back as `error`, with
   * whatever the role's tools recorded before it: the caller decides whether to try again.
   */
  const runRole = async (
    botId: string,
    role: CodingRole,
    text: string,
    phase: Phase,
    signal: AbortSignal,
    startLine: string,
    card?: { id: string; kind: "file" | "connector"; path?: string },
    finalCheck = false,
    visual = false,
  ): Promise<{ reply: Message; capture: TurnCapture; error?: string }> => {
    const project = load(botId);
    const roleBot = project && store.bots.get(project.roles[role].botId);
    // A team thread that was deleted (or given other members) is made again rather than ending the project.
    const pair = roleBot && ensurePair(botId, roleBot, role);
    if (signal.aborted || !project || !roleBot || !pair) throw new Halt();
    const sent = store.messages.create({
      threadId: pair.id,
      role: "bot",
      botId,
      parts: [{ type: "text", text }],
    });
    bus.publish({ type: "message.created", message: sent });
    const startedMs = timing.now();
    const capture: TurnCapture = {
      ...(card ? { card: { id: card.id, kind: card.kind, path: card.path } } : {}),
      ...(finalCheck ? { finalCheck: true } : {}),
      ...(visual ? { visual: true } : {}),
    };
    captures.set(roleBot.id, capture);
    change(botId, (p) => {
      p.active = { role, cardId: card?.id ?? null, since: new Date(startedMs).toISOString() };
      logLine(p, startLine);
    });
    // Time spent waiting for the shared model (behind other bots) isn't time spent on the card: the turn shows
    // "queued" in its thread until it gets the model.
    let queuedSince: number | null = null;
    let queuedMs = 0;
    const unwatchQueue = bus.subscribe((event) => {
      if (event.type !== "thread.activity" || event.threadId !== pair.id) return;
      if (event.activity === "queued") queuedSince ??= timing.now();
      else if (queuedSince !== null) {
        queuedMs += timing.now() - queuedSince;
        queuedSince = null;
        // The screen counts the running turn from `since`: it starts when the model is the turn's.
        change(botId, (p) => {
          if (p.active?.role === role) p.active.since = new Date(startedMs + queuedMs).toISOString();
        });
      }
    });
    const workedMs = () =>
      timing.now() - startedMs - queuedMs - (queuedSince === null ? 0 : timing.now() - queuedSince);
    // A card that has taken too long is said so once a round; the note says how long as the turn goes on.
    let slow: ReturnType<typeof setTimeout> | undefined;
    let reply: Message | undefined;
    if (card) {
      const watch = () => {
        const p = load(botId);
        const target = p && cardOf(p, card.id);
        if (!p || !target) return;
        const total = workOf(target).seconds + workedMs() / 1000;
        if (total < timing.slowSeconds) {
          slow = setTimeout(watch, Math.max(1, (timing.slowSeconds - total) * 1000));
          return;
        }
        const key = `${role}:${card.id}:${p.round}`;
        change(botId, (q) => {
          q.note = `${ROLE_NAMES[role]} is working on ${target.title} (${Math.round(total / 60)} min so far)`;
          if (!warned.has(key)) {
            warned.add(key);
            // The time is the card's, over every turn on it: the role is only who has it now.
            logLine(q, `${target.title} has taken ${minutes(total)} so far (${ROLE_NAMES[role]} is on it)`);
          }
        });
        slow = setTimeout(watch, timing.tickMs);
      };
      // Time already spent on the card in earlier turns counts: the first look is when the total would pass the limit.
      const spent = cardOf(project, card.id)?.work?.seconds ?? 0;
      slow = setTimeout(watch, Math.max(1, (timing.slowSeconds - spent) * 1000));
    }
    try {
      // Queued behind the shared model like any helper; not a whole turn (a command waiting for the user's answer must
      // not hold the model) and not unattended (the user is watching, and its cards appear in the phase's message).
      reply = await turns.start(pair, store.bots.get(roleBot.id) ?? roleBot, "routine", {
        delegated: true,
        standalone: true,
        surface: phase.surface,
        parentSignal: signal,
      });
      if (signal.aborted) throw new Halt();
      if (reply.status === "error") return { reply, capture, error: errorOf(reply) };
      // Not finished and not the project's own Stop: someone pressed Stop or Clear chat in the team thread (a cleared
      // reply is gone before it could be marked stopped, so it still says streaming).
      if (reply.status !== "done") throw new StoppedFromTeam();
      return { reply, capture };
    } catch (error) {
      if (error instanceof TurnCancelled) throw signal.aborted ? new Halt() : new StoppedFromTeam();
      throw error;
    } finally {
      clearTimeout(slow);
      unwatchQueue();
      if (captures.get(roleBot.id) === capture) captures.delete(roleBot.id);
      const seconds = Math.round((Math.max(0, workedMs()) / 1000) * 10) / 10;
      change(botId, (p) => {
        if (p.active?.role === role) p.active = null;
        // What the turn cost is added to its card, whatever became of the turn.
        const target = card && cardOf(p, card.id);
        if (target) {
          const work = workOf(target);
          work.seconds = Math.round((work.seconds + seconds) * 10) / 10;
          work.inputTokens += reply?.usage?.inputTokens ?? 0;
          work.outputTokens += reply?.usage?.outputTokens ?? 0;
          work.turns += 1;
        }
      });
      // Approval cards set the activity of the Coding Bot's chat; nothing else clears it once the turn is over.
      const codingThread = store.bots.get(botId)?.threadId;
      if (codingThread && !turns.isBusy(codingThread)) turns.setActivity(codingThread, null, "idle");
    }
  };

  // ---- planning ---------------------------------------------------------------------------------------------

  const NO_PLAN =
    "You didn't send a plan. Call propose_plan with the files (nodes) and connections (edges), or reply with the plan as one JSON code block.";

  /**
   * The board for a new plan. A card whose file (same path and purpose) or connection (same files and description, all
   * of them unchanged) was already on the board keeps where it was, with its comments and time: a change to a built
   * project rewrites only what changed. The other cards start in Todo, and on a built project they carry the user's
   * request (which is also what keeps an existing file from being sent straight to QA unchanged).
   */
  const boardFor = (
    old: CodingProject,
    nodes: CodingNode[],
    edges: CodingEdge[],
    revision: Revision | null,
  ): { cards: CodingCard[]; kept: number } => {
    const cards = cardsFor(nodes, edges);
    if (!revision || old.cards.length === 0) return { cards, kept: 0 };
    const key = (path: string) => path.toLowerCase();
    const oldNode = (path: string) => old.nodes.find((node) => key(node.path) === key(path));
    const unchanged = new Set(
      nodes.filter((node) => oldNode(node.path)?.purpose === node.purpose).map((node) => node.id),
    );
    const filesOf = (files: string[], list: CodingNode[]) =>
      files
        .map((id) => key(list.find((node) => node.id === id)?.path ?? id))
        .toSorted()
        .join("|");
    const built = old.cards.some((card) => card.column === "done");
    let kept = 0;
    for (const card of cards) {
      let before: CodingCard | undefined;
      if (card.kind === "file") {
        const node = nodes.find((candidate) => candidate.id === card.ref)!;
        const previous = unchanged.has(node.id) ? oldNode(node.path) : undefined;
        before = previous && old.cards.find((other) => other.kind === "file" && other.ref === previous.id);
      } else {
        const edge = edges.find((candidate) => candidate.id === card.ref)!;
        const same =
          edge.files.every((id) => unchanged.has(id)) &&
          old.edges.find(
            (other) =>
              other.description === edge.description &&
              filesOf(other.files, old.nodes) === filesOf(edge.files, nodes),
          );
        before = same
          ? old.cards.find((other) => other.kind === "connector" && other.ref === same.id)
          : undefined;
      }
      if (before) {
        // In progress means nothing once the plan is new: it is picked up again from Todo.
        card.column = before.column === "in_progress" ? "todo" : before.column;
        card.comments = before.comments;
        card.work = before.work ?? card.work;
        if (card.column === "done") kept += 1;
      } else if (built)
        card.comments.push(comment("user", "note", `Change asked for: ${revision.text}`, old.round));
    }
    return { cards, kept };
  };

  const planning = async (botId: string, signal: AbortSignal) => {
    const phase = openPhase(botId, "Planning: the Planner is drawing the files and connections…");
    let closing: [string, "done" | "stopped"] = ["Stopped.", "stopped"];
    const revision = revisionOf(botId);
    try {
      let problems: string[] = [];
      let lastError = "";
      for (let attempt = 0; attempt <= MAX_PLAN_RETRIES; attempt++) {
        const project = need(botId);
        const { reply, capture, error } = await runRole(
          botId,
          "planner",
          plannerMessage(project, {
            problems,
            ...(revision ? { revision: revision.text, built: revision.built } : {}),
          }),
          phase,
          signal,
          attempt === 0 ? "Planner started the plan" : `Planner started the plan again (try ${attempt + 1})`,
        );
        const raw = capture.plan ? null : planFromReply(messageText(reply));
        // A model that failed before handing in a plan is asked again after a short wait (it counts as a try).
        if (error && !capture.plan && !raw) {
          lastError = error;
          note(botId, `The Planner's model failed: ${clip(error, 120)}`);
          if (attempt < MAX_PLAN_RETRIES) {
            phase.say(
              `The Planner's model failed; trying again (try ${attempt + 2} of ${MAX_PLAN_RETRIES + 1})…`,
            );
            await backoff(attempt + 1, signal);
          }
          continue;
        }
        const found =
          capture.plan ??
          (raw ? validatePlan(raw) : { ok: false as const, errors: capture.rejected ?? [NO_PLAN] });
        if (found.ok) {
          let auto = false;
          let kept = 0;
          change(botId, (p) => {
            const board = boardFor(p, found.nodes, found.edges, revision);
            kept = board.kept;
            p.nodes = found.nodes;
            p.edges = found.edges;
            p.cards = board.cards;
            p.round = 0;
            p.error = null;
            auto = p.autoApprove;
            p.status = auto ? "developing" : "awaiting_approval";
            const ready =
              kept > 0
                ? `Updated plan ready (${kept} card${kept === 1 ? "" : "s"} kept as done)`
                : "Plan ready";
            p.note = auto
              ? `${ready}; auto-approve is on, so the Developer starts.`
              : `${ready}: approve it or ask for changes.`;
            logLine(
              p,
              `Planner finished the plan: ${found.nodes.length} files, ${found.edges.length} connections`,
            );
          });
          setRevision(botId, null);
          closing = [
            `${kept > 0 ? "Updated plan ready" : "Plan ready"}: ${found.nodes.length} files and ${found.edges.length} connections${kept > 0 ? `; ${kept} card${kept === 1 ? "" : "s"} that didn't change stay done` : ""}.${auto ? " Auto-approve is on, so the Developer starts now." : " Approve it, or tell me what to change."}`,
            "done",
          ];
          return;
        }
        problems = found.errors;
        lastError = "";
        phase.say(
          `The Planner's plan had problems; asking again (try ${attempt + 2} of ${MAX_PLAN_RETRIES + 1})…`,
        );
        note(botId, `Plan not accepted: ${clip(problems[0] ?? "", 120)}`);
      }
      throw new Failure(
        lastError
          ? `The Planner couldn't finish after ${MAX_PLAN_RETRIES + 1} tries: ${lastError}`
          : `The Planner couldn't make a valid plan after ${MAX_PLAN_RETRIES + 1} tries. The last problems: ${problems.join(" ")}`,
      );
    } finally {
      phase.close(...closing);
    }
  };

  // ---- developing -------------------------------------------------------------------------------------------

  /** A planned file's content as a hash ("" when it isn't there), to see which files a turn changed. */
  const fingerprints = (project: CodingProject): Map<string, string> =>
    new Map(
      project.nodes.map((node) => {
        try {
          return [
            node.path,
            createHash("sha1")
              .update(readFileSync(join(project.outputFolder, node.path)))
              .digest("hex"),
          ];
        } catch {
          return [node.path, ""];
        }
      }),
    );

  /**
   * A Developer turn changed planned files: every other card that touches one of them and had passed goes back to QA,
   * because it was checked against what the file used to say. (A card still waiting in QA, Todo or In progress will be
   * looked at anyway.) The project can't be done while one of them is waiting.
   */
  const requeueStale = (botId: string, cardId: string, before: Map<string, string>) => {
    const project = load(botId);
    if (!project) return;
    const after = fingerprints(project);
    const changed = project.nodes.filter((node) => before.get(node.path) !== after.get(node.path));
    if (changed.length === 0) return;
    change(botId, (p) => {
      const worked = cardOf(p, cardId);
      for (const other of p.cards) {
        if (other.id === cardId || other.column !== "done") continue;
        const touched = changed.find((node) =>
          other.kind === "file"
            ? other.ref === node.id
            : p.edges.find((edge) => edge.id === other.ref)?.files.includes(node.id),
        );
        if (!touched) continue;
        other.column = "qa";
        other.comments.push(
          comment(
            "qa",
            "requeue",
            `Back in QA: ${touched.path} changed after this card passed (while ${worked?.title ?? "another card"} was being worked on), so it has to be checked again.`,
            p.round + 1,
          ),
        );
        logLine(
          p,
          `${touched.path} changed while fixing ${worked?.title ?? "another card"}; ${other.title} goes back to QA`,
        );
      }
    });
  };

  const developCard = async (botId: string, cardId: string, phase: Phase, signal: AbortSignal) => {
    let last: LastTry | null = null;
    for (let tries = 1; tries <= MAX_TRIES; tries++) {
      const project = need(botId);
      const card = cardOf(project, cardId);
      if (!card) throw new Halt();
      const node =
        card.kind === "file" ? project.nodes.find((candidate) => candidate.id === card.ref) : undefined;
      if (card.column !== "in_progress")
        change(botId, (p) => {
          const target = cardOf(p, cardId)!;
          target.column = "in_progress";
          // Set once, the first time the card is picked up: it stays when QA sends the card back.
          workOf(target).startedAt ??= now();
          p.note = `Developer is working on ${card.title}`;
        });
      phase.say(
        `Developing (round ${project.round + 1}): ${card.title} (${project.cards.indexOf(card) + 1} of ${project.cards.length})${tries > 1 ? `, try ${tries}` : ""}…`,
      );
      const before = fingerprints(project);
      let turn: Awaited<ReturnType<typeof runRole>>;
      try {
        turn = await runRole(
          botId,
          "developer",
          developerMessage(project, card, last),
          phase,
          signal,
          tries > 1 ? `Developer is trying ${card.title} again` : `Developer started ${card.title}`,
          { id: card.id, kind: card.kind, path: node?.path },
        );
      } finally {
        // Whatever became of the turn, the files it touched are not what other cards were checked against.
        requeueStale(botId, cardId, before);
      }
      const { capture, error } = turn;
      const after = fingerprints(need(botId));
      // A file card's file that is there, not empty and changed in this try is the work, whether or not the model
      // remembered to call finish_card (small models often stop right after writing).
      const wrote =
        !!node &&
        after.get(node.path) !== before.get(node.path) &&
        writtenIn(project.outputFolder)(node.path);
      if (capture.finished || wrote) {
        const finished = capture.finished;
        change(botId, (p) => {
          const target = cardOf(p, cardId)!;
          target.column = "qa";
          if (finished?.note) target.comments.push(comment("developer", "note", finished.note, p.round));
          p.note = null;
          logLine(
            p,
            finished
              ? `Developer finished ${card.title}`
              : `${node!.path} was written; sent to QA (finish_card wasn't called)`,
          );
        });
        return;
      }
      const changed = project.nodes.some((other) => after.get(other.path) !== before.get(other.path));
      last = {
        reads: capture.reads?.length ?? 0,
        wrote: changed || capture.wrote === true,
        stepLimit: (capture.steps ?? 0) >= DEVELOPER_MAX_STEPS - 1,
        ...(error ? { error: clip(error, 200) } : {}),
      };
      if (error) {
        note(botId, `The Developer's model failed on ${card.title}: ${clip(error, 100)}`);
        if (tries < MAX_TRIES) await backoff(tries, signal);
      }
    }
    const title = cardOf(need(botId), cardId)?.title ?? cardId;
    throw new Failure(
      last?.error
        ? `The Developer couldn't finish “${title}” after ${MAX_TRIES} tries: ${last.error} Resume to try again.`
        : `The Developer didn't finish “${title}” after ${MAX_TRIES} tries (it never called finish_card${last && !last.wrote ? ` and wrote nothing after reading ${last.reads} file${last.reads === 1 ? "" : "s"}` : ""}). Resume to try again.`,
    );
  };

  const developing = async (botId: string, signal: AbortSignal) => {
    let phase: Phase | undefined;
    let written = 0;
    let closing: [string, "done" | "stopped"] = ["Stopped.", "stopped"];
    try {
      for (;;) {
        if (signal.aborted) throw new Halt();
        const project = need(botId);
        const card = nextForDeveloper(project);
        if (!card) break;
        if (alreadyWritten(project, card)) {
          change(botId, (p) => {
            cardOf(p, card.id)!.column = "qa";
            logLine(p, `${card.title} was already written; sent to QA`);
          });
          continue;
        }
        phase ??= openPhase(botId, `Developing (round ${project.round + 1} of up to ${project.maxRounds})…`);
        await developCard(botId, card.id, phase, signal);
        written += 1;
      }
      const project = need(botId);
      if (reviewable(project).length > 0) {
        change(botId, (p) => {
          p.status = "qa";
          p.note = "QA is reviewing the cards.";
          logLine(p, `Development pass finished (${written} card${written === 1 ? "" : "s"} written)`);
        });
        closing = [
          `Development pass finished: ${written} card${written === 1 ? "" : "s"} written. QA is next.`,
          "done",
        ];
      } else if (project.cards.every((card) => card.column === "done")) {
        // Every card has passed: the project is checked as a whole before it is called done.
        change(botId, (p) => {
          p.status = "qa";
          p.note = "QA is checking the whole project.";
        });
        closing = ["Every card has passed QA. The whole project is checked next.", "done"];
      } else throw new Failure("No card can be worked on: the board is stuck.");
    } finally {
      phase?.close(...closing);
    }
  };

  // ---- QA ---------------------------------------------------------------------------------------------------

  /** Applies QA's verdict: the service moves the card, and a file that fails sends its finished connections back to QA. */
  const applyReview = (botId: string, cardId: string, review: { pass: boolean; comment: string }) => {
    change(botId, (p) => {
      const card = cardOf(p, cardId)!;
      if (review.comment)
        card.comments.push(comment("qa", review.pass ? "pass" : "fail", review.comment, p.round + 1));
      // The slow-card note was about this review, which is over.
      if (p.note?.startsWith(`${ROLE_NAMES.qa} is working on`)) p.note = "QA is reviewing the cards.";
      if (review.pass) {
        card.column = "done";
        logLine(p, `QA passed ${card.title}`);
        return;
      }
      card.column = "todo";
      logLine(p, `QA sent ${card.title} back: ${clip(review.comment, 70)}`);
      if (card.kind !== "file") return;
      // A file that changes can break a connection that already passed.
      for (const connector of connectorsTouching(p, card.ref)) {
        if (connector.column !== "done") continue;
        connector.column = "qa";
        connector.comments.push(
          comment(
            "qa",
            "requeue",
            `Back in QA: ${card.title} failed review after this connection passed, so the connection has to be checked again once the file is fixed.`,
            p.round + 1,
          ),
        );
        logLine(p, `${connector.title} goes back to QA because ${card.title} changed`);
      }
    });
  };

  const reviewCard = async (botId: string, cardId: string, phase: Phase, signal: AbortSignal) => {
    let lastError = "";
    for (let tries = 1; tries <= MAX_TRIES; tries++) {
      const project = need(botId);
      const card = cardOf(project, cardId);
      if (!card) throw new Halt();
      const { capture, error } = await runRole(
        botId,
        "qa",
        qaMessage(project, card, tries > 1),
        phase,
        signal,
        tries > 1 ? `QA is looking at ${card.title} again` : `QA started ${card.title}`,
        { id: card.id, kind: card.kind },
      );
      // A verdict QA gave stands even when the model failed afterwards.
      if (capture.review) {
        applyReview(botId, cardId, capture.review);
        return capture.review.pass;
      }
      lastError = error ?? "";
      if (error) {
        note(botId, `QA's model failed on ${card.title}: ${clip(error, 100)}`);
        if (tries < MAX_TRIES) await backoff(tries, signal);
      }
    }
    const title = cardOf(need(botId), cardId)?.title ?? cardId;
    throw new Failure(
      lastError
        ? `QA couldn't review “${title}” after ${MAX_TRIES} tries: ${clip(lastError, 200)} Resume to try again.`
        : `QA didn't give a verdict on “${title}” after ${MAX_TRIES} tries (it never called review_card). Resume to try again.`,
    );
  };

  const finishProject = (botId: string) => {
    const project = change(botId, (p) => {
      p.status = "done";
      p.note = `Every card passed QA${p.round > 0 ? ` after ${p.round} round${p.round === 1 ? "" : "s"}` : ""}.`;
      p.error = null;
      logLine(p, "Every card passed QA: the project is done");
    });
    if (!project) return;
    const todo = beforeYouRun(projectFiles(project));
    say(
      botId,
      `Done: all ${project.cards.length} cards passed QA. The project is in ${project.outputFolder}.${
        todo.length > 0 ? `\n\nBefore you run it:\n${todo.map((line) => `- ${line}`).join("\n")}` : ""
      }`,
    );
  };

  /** The planned files and a way to read them (and any other file inside the output folder), for the project checks. */
  const projectFiles = (project: CodingProject) => ({
    files: project.nodes.map((node) => node.path),
    read: (path: string): string | null => {
      const abs = resolve(project.outputFolder, path);
      const rel = relative(resolve(project.outputFolder), abs);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
      try {
        const info = statSync(abs);
        return info.isFile() && info.size <= 2_000_000 ? readFileSync(abs, "utf8") : null;
      } catch {
        return null;
      }
    },
  });

  /** The card a finding goes back to: the connection between the files it spans, else the card of the file it is in. */
  const cardForFinding = (
    project: CodingProject,
    file: string,
    related: string[] = [],
  ): CodingCard | undefined => {
    const node = project.nodes.find((candidate) => candidate.path.toLowerCase() === file.toLowerCase());
    if (!node) return undefined;
    const others = related.flatMap(
      (path) => project.nodes.find((candidate) => candidate.path.toLowerCase() === path.toLowerCase()) ?? [],
    );
    const edge = project.edges.find(
      (candidate) =>
        candidate.files.includes(node.id) && others.some((other) => candidate.files.includes(other.id)),
    );
    return (
      (edge && project.cards.find((card) => card.kind === "connector" && card.ref === edge.id)) ||
      project.cards.find((card) => card.kind === "file" && card.ref === node.id)
    );
  };

  /** Sends cards back to the Developer with what is wrong as QA's comment; returns how many cards went back. */
  const sendBack = (
    botId: string,
    items: { card: CodingCard; text: string }[],
    round: number,
    source: string,
    kind: "check" | "fail",
  ) => {
    const byCard = new Map<string, string[]>();
    for (const { card, text } of items) byCard.set(card.id, [...(byCard.get(card.id) ?? []), text]);
    if (byCard.size === 0) return 0;
    change(botId, (p) => {
      for (const [id, texts] of byCard) {
        const card = cardOf(p, id);
        if (!card) continue;
        const text = texts.length === 1 ? texts[0]! : texts.map((line) => `- ${line}`).join("\n");
        card.column = "todo";
        card.comments.push(comment("qa", kind, text, round));
        logLine(p, `${source} sent ${card.title} back: ${clip(texts[0]!, 70)}`);
      }
    });
    return byCard.size;
  };

  /**
   * The check of the whole project once every card has passed: automatic checks first (nothing is asked of a model);
   * if they find nothing, one QA turn looks at the project as a whole. Returns how many cards were sent back.
   */
  const finalCheck = async (
    botId: string,
    phase: Phase,
    signal: AbortSignal,
    round: number,
  ): Promise<number> => {
    const project = need(botId);
    phase.say(`QA (round ${round}): checking the whole project…`);
    const findings: Finding[] = checkProject(projectFiles(project));
    if (findings.length > 0) {
      const items = findings.flatMap((finding) => {
        const card = cardForFinding(project, finding.file, finding.related);
        return card ? [{ card, text: finding.problem }] : [];
      });
      return sendBack(botId, items, round, "The automatic check", "check");
    }
    note(botId, "The automatic checks of the whole project found nothing");
    let lastError = "";
    for (let tries = 1; tries <= MAX_TRIES; tries++) {
      const current = need(botId);
      const { capture, error } = await runRole(
        botId,
        "qa",
        finalCheckMessage(
          current,
          "all clear (script tags and the files they load, imports and exports, element ids, JSON files, made-up secrets).",
          tries > 1,
        ),
        phase,
        signal,
        tries > 1 ? "QA is checking the whole project again" : "QA started checking the whole project",
        undefined,
        true,
      );
      if (!capture.check) {
        lastError = error ?? "";
        if (error) {
          note(botId, `QA's model failed on the check of the whole project: ${clip(error, 100)}`);
          if (tries < MAX_TRIES) await backoff(tries, signal);
        }
        continue;
      }
      if (capture.check.ok) {
        note(botId, "QA's check of the whole project: all good");
        return 0;
      }
      const items = capture.check.problems.flatMap((problem) => {
        const card = cardForFinding(current, problem.file);
        return card ? [{ card, text: problem.comment }] : [];
      });
      return sendBack(botId, items, round, "QA's check of the whole project", "fail");
    }
    throw new Failure(
      lastError
        ? `QA couldn't check the whole project after ${MAX_TRIES} tries: ${clip(lastError, 200)} Resume to try again.`
        : `QA didn't give a verdict on the whole project after ${MAX_TRIES} tries (it never called finish_check). Resume to try again.`,
    );
  };

  /** Whether QA's model can see pictures (screenshots); a model the catalog doesn't know is taken as not. */
  const qaSeesPictures = async (project: CodingProject): Promise<boolean> => {
    const ref = project.roles.qa.model ?? runtime.settings.sharedModel;
    if (!ref) return false;
    const info = await catalog.info(ref).catch(() => null);
    return Boolean(info?.capabilities.includes("vision"));
  };

  /**
   * Visual QA, once every card passed and the checks of the whole project found nothing: QA starts the app, opens it in
   * its own browser tab and uses it like a person. What the automatic part finds (a crash on start, errors in the
   * console, files that failed to load, buttons that do nothing or are covered) goes back to the Developer whatever
   * QA decides; QA adds what it saw going wrong. Returns how many cards were sent back.
   */
  const visualCheck = async (
    botId: string,
    phase: Phase,
    signal: AbortSignal,
    round: number,
  ): Promise<number> => {
    const project = need(botId);
    const files = projectFiles(project);
    const run: RunSpec = detectRun({ ...files, python: process.platform === "win32" ? "python" : "python3" });
    if (run.kind === "none") {
      note(botId, "Visual QA: the project has nothing with a screen to open, so there was nothing to test");
      return 0;
    }
    phase.say(`QA (round ${round}): Visual QA, using the app…`);
    note(botId, `Visual QA: ${describeRun(run)}`);
    const vision = await qaSeesPictures(project);
    if (!vision && run.kind !== "desktop")
      note(
        botId,
        "Visual QA: QA's model can't see pictures, so it tests by the screen map and the console only",
      );
    let lastError = "";
    let neverStarted = false;
    for (let tries = 1; tries <= MAX_TRIES; tries++) {
      const current = need(botId);
      const session = new VisualSession({
        browser,
        botId: current.roles.qa.botId,
        outputFolder: current.outputFolder,
        planned: files.files,
        run,
        read: files.read,
        refuse: secretFileReason,
      });
      visualSessions.set(botId, session);
      let outcome: { capture: TurnCapture; error?: string };
      try {
        outcome = await runRole(
          botId,
          "qa",
          visualQaMessage(current, run, { vision, retry: tries > 1 }),
          phase,
          signal,
          tries > 1 ? "QA is trying Visual QA again" : "QA started Visual QA",
          undefined,
          false,
          true,
        );
      } finally {
        visualSessions.delete(botId);
        await session.stop();
      }
      const { capture, error } = outcome;
      // Nothing was tested, and trying again won't change that: whatever QA said, the project stops and says why.
      if (session.browserError)
        throw new Failure(
          `Visual QA couldn't open the app in the browser: ${clip(session.browserError, 160)} Check Settings → Browser & search, or turn Visual QA off, then Resume.`,
        );
      if (session.missing)
        throw new Failure(
          `Visual QA couldn't start the app: ${session.missing} isn't installed on this computer. Install it, or turn Visual QA off, then Resume.`,
        );
      if (session.auto.length > 0)
        note(
          botId,
          `Visual QA's automatic checks found ${session.auto.length} problem${session.auto.length === 1 ? "" : "s"}`,
        );
      // A verdict on an app QA never opened is no verdict: nothing was tested.
      if (!session.started && !error) {
        neverStarted = true;
        lastError = "";
        note(botId, "QA gave a Visual QA verdict without starting the app (or its start command was denied)");
        continue;
      }
      if (!capture.check && session.auto.length === 0) {
        lastError = error ?? "";
        if (error) {
          note(botId, `QA's model failed in Visual QA: ${clip(error, 100)}`);
          if (tries < MAX_TRIES) await backoff(tries, signal);
        }
        continue;
      }
      const latest = need(botId);
      const automatic = session.auto.flatMap((finding) => {
        const card = cardForFinding(latest, finding.file, finding.related);
        return card ? [{ card, text: `Visual QA: ${finding.problem}` }] : [];
      });
      const seen = (capture.check?.problems ?? []).flatMap((problem) => {
        const card = cardForFinding(latest, problem.file);
        return card ? [{ card, text: `Visual QA: ${problem.comment}` }] : [];
      });
      if (automatic.length === 0 && seen.length === 0) {
        if (session.auto.length > 0)
          note(botId, `Visual QA found problems no card owns: ${clip(formatFindings(session.auto), 200)}`);
        note(botId, "Visual QA: all good");
        return 0;
      }
      const back = new Set([...automatic, ...seen].map((item) => item.card.id)).size;
      sendBack(botId, automatic, round, "Visual QA's automatic check", "check");
      sendBack(botId, seen, round, "Visual QA", "fail");
      return back;
    }
    throw new Failure(
      lastError
        ? `QA couldn't finish Visual QA after ${MAX_TRIES} tries: ${clip(lastError, 200)} Resume to try again, or turn Visual QA off.`
        : neverStarted
          ? `Visual QA never got the app open after ${MAX_TRIES} tries: QA didn't start it, or its start command was denied. Resume and allow the command, give QA a stronger model, or turn Visual QA off.`
          : `QA didn't give a Visual QA verdict after ${MAX_TRIES} tries (it never called finish_visual_check). Resume to try again, or turn Visual QA off.`,
    );
  };

  const reviewing = async (botId: string, signal: AbortSignal) => {
    let phase: Phase | undefined;
    let closing: [string, "done" | "stopped"] = ["Stopped.", "stopped"];
    try {
      // Cards that come back to QA during this pass wait for the next one, after the Developer has fixed the file.
      const queue = reviewable(need(botId)).map((card) => card.id);
      let reviewed = 0;
      let passed = 0;
      for (const id of queue) {
        if (signal.aborted) throw new Halt();
        const project = need(botId);
        const card = cardOf(project, id);
        // A connection whose file just failed has nothing to be checked against yet.
        if (!card || card.column !== "qa" || !filesReady(project, card)) continue;
        phase ??= openPhase(botId, `QA (round ${project.round + 1} of up to ${project.maxRounds})…`);
        phase.say(`QA (round ${project.round + 1}): ${card.title} (${reviewed + 1} of ${queue.length})…`);
        if (await reviewCard(botId, id, phase, signal)) passed += 1;
        reviewed += 1;
      }
      const everyCardDone = need(botId).cards.every((card) => card.column === "done");
      if (reviewed === 0 && !everyCardDone) {
        // Nothing could be reviewed: back to the Developer, or the board is stuck.
        if (!nextForDeveloper(need(botId)))
          throw new Failure("No card can be worked on: the board is stuck.");
        change(botId, (p) => void (p.status = "developing"));
        return;
      }
      const counted = reviewed > 0 ? change(botId, (p) => void (p.round += 1))! : need(botId);
      // Every card passed: the whole project is checked, as part of this QA pass.
      let checked = 0;
      if (counted.cards.every((card) => card.column === "done")) {
        phase ??= openPhase(botId, `QA (round ${counted.round + 1} of up to ${counted.maxRounds})…`);
        checked = await finalCheck(botId, phase, signal, reviewed > 0 ? counted.round : counted.round + 1);
        // Visual QA comes last, on top of QA's other checks: only a project that passed them all is used.
        if (checked === 0 && need(botId).visualQa)
          checked = await visualCheck(botId, phase, signal, reviewed > 0 ? counted.round : counted.round + 1);
      }
      const project = need(botId);
      const left = project.cards.filter((card) => card.column !== "done");
      const failed = reviewed - passed + checked;
      if (left.length === 0) {
        finishProject(botId);
        closing = [
          `Round ${project.round}: all ${project.cards.length} cards passed QA and the whole project was checked.`,
          "done",
        ];
      } else if (project.round >= project.maxRounds) {
        const summary = left
          .map((card) => {
            const last = card.comments.findLast((said) => said.author === "qa");
            return `${card.title}${last ? ` (${clip(last.text, 80)})` : ""}`;
          })
          .join("; ");
        change(botId, (p) => {
          p.status = "needs_you";
          p.note = clip(
            `Round ${p.round} of ${p.maxRounds} is done and ${left.length} card${left.length === 1 ? "" : "s"} still fail: ${summary}`,
            600,
          );
          logLine(p, `Round limit reached: ${left.length} card${left.length === 1 ? "" : "s"} still fail`);
        });
        say(
          botId,
          `I stopped after round ${project.round} of ${project.maxRounds}. These cards still fail:\n${left.map((card) => `- ${card.title}`).join("\n")}\nRaise the round limit and resume, or step in and fix them.`,
        );
        closing = [
          `Round ${project.round} of ${project.maxRounds}: ${failed} card${failed === 1 ? "" : "s"} still failing. Waiting for you.`,
          "done",
        ];
      } else {
        change(botId, (p) => {
          p.status = "developing";
          p.note = `Round ${p.round} done: ${failed} card${failed === 1 ? "" : "s"} sent back to the Developer.`;
          logLine(p, `Round ${p.round} done: ${passed} passed, ${failed} sent back`);
        });
        closing = [
          `Round ${project.round}: ${passed} of ${reviewed} passed, ${failed} sent back to the Developer.`,
          "done",
        ];
      }
    } finally {
      phase?.close(...closing);
    }
  };

  // ---- the loop ---------------------------------------------------------------------------------------------

  /**
   * Stops the project with an error: the plan that was never approved stays waiting for approval (the change asked for
   * is dropped: ask again). A change to a built project stays saved, so Resume asks the Planner again.
   */
  const failProject = (botId: string, message: string) => {
    change(botId, (p) => {
      const waiting = p.status === "planning" && p.cards.length > 0 && !revisionOf(botId)?.built;
      if (waiting) setRevision(botId, null);
      p.status = waiting ? "awaiting_approval" : "error";
      p.error = message;
      p.active = null;
      p.note = null;
      p.cards = p.cards.map((card) => (card.column === "in_progress" ? { ...card, column: "todo" } : card));
      logLine(p, `Stopped with an error: ${clip(message, 140)}`);
    });
    say(botId, `I stopped because of a problem: ${message}`);
  };

  /**
   * A role's turn was stopped from its team thread (Stop, Clear chat) while the project was working: the project is
   * stopped properly, as Stop in the Coding Bot's own chat does, instead of saying it works while nothing runs.
   */
  const stoppedFromTeam = (botId: string) => {
    change(botId, (p) => {
      if (!isCodingBusy(p.status)) return;
      p.status = interruptedStatus(p);
      p.active = null;
      p.note =
        p.status === "awaiting_approval"
          ? "Stopped from the team's conversation; the plan is waiting for your approval."
          : "Stopped from the team's conversation; press Resume to carry on.";
      p.cards = p.cards.map((card) => (card.column === "in_progress" ? { ...card, column: "todo" } : card));
      logLine(p, "The team was stopped from one of its conversations");
    });
  };

  const drive = async (botId: string, run: Run) => {
    const { signal } = run.controller;
    try {
      for (;;) {
        const project = load(botId);
        // Taken off the list in the same breath as the last status is read, so a later Approve or Resume starts a new run.
        if (signal.aborted || !project || !isCodingBusy(project.status)) return;
        if (project.status === "planning") await planning(botId, signal);
        else if (project.status === "developing") await developing(botId, signal);
        else await reviewing(botId, signal);
      }
    } catch (error) {
      if (error instanceof Halt || signal.aborted) return;
      if (error instanceof StoppedFromTeam) return stoppedFromTeam(botId);
      if (!(error instanceof Failure)) console.error("[coding] the project failed", error);
      failProject(botId, error instanceof Failure ? error.message : (error as Error).message);
    } finally {
      if (runs.get(botId) === run) runs.delete(botId);
    }
  };

  const launch = (botId: string) => {
    const previous = runs.get(botId);
    if (previous && !previous.controller.signal.aborted) return;
    const run: Run = { controller: new AbortController(), done: Promise.resolve() };
    runs.set(botId, run);
    // A stopped run that hasn't wound down yet (Stop waits only so long) ends first: two runs never work at once.
    run.done = previous ? previous.done.then(() => drive(botId, run)) : drive(botId, run);
  };

  /**
   * Ends the work in progress and waits (briefly) for it to wind down. A run still winding down after that stays
   * listed, so a Resume waits for it instead of starting a second one beside it.
   */
  const halt = async (botId: string) => {
    const run = runs.get(botId);
    // The run's signal first: a role turn that ends now is then seen as the project's own Stop.
    run?.controller.abort();
    const project = load(botId);
    if (project) for (const role of CODING_ROLES) turns.stopBot(project.roles[role].botId);
    if (!run) return;
    await Promise.race([run.done, new Promise((done) => setTimeout(done, timing.stopWaitMs).unref())]);
  };

  // ---- what the user can do ---------------------------------------------------------------------------------

  const notAllowed = (message: string) => new CodingError(message, "wrong_state", 409);

  const approve = (botId: string): CodingProject => {
    const project = need(botId);
    if (project.status !== "awaiting_approval")
      throw notAllowed("There is no plan waiting for your approval.");
    change(botId, (p) => {
      p.status = "developing";
      p.error = null;
      p.note = "Plan approved: the Developer is starting.";
      logLine(p, "You approved the plan");
    });
    say(botId, "Plan approved. The Developer is starting.");
    launch(botId);
    return need(botId);
  };

  const revise = (botId: string, text: string): CodingProject => {
    const project = need(botId);
    if (project.status !== "awaiting_approval")
      throw notAllowed("There is no plan waiting for your approval.");
    setRevision(botId, { text, built: false });
    change(botId, (p) => {
      p.status = "planning";
      p.error = null;
      p.note = "The Planner is changing the plan.";
      logLine(p, `You asked for changes: ${clip(text, 100)}`);
    });
    launch(botId);
    return need(botId);
  };

  /**
   * A message to a project that is done is a change to it: the Planner gets the plan it was built from and the request,
   * and the updated plan waits for approval as any plan does. Cards of the files that don't change stay done.
   */
  const changeBuilt = (botId: string, text: string) => {
    setRevision(botId, { text, built: true });
    change(botId, (p) => {
      p.status = "planning";
      p.error = null;
      p.note = "The Planner is updating the plan for your change.";
      logLine(p, `You asked for a change: ${clip(text, 100)}`);
    });
    say(
      botId,
      `I've asked the Planner to update the plan for that change. ${need(botId).autoApprove ? "Auto-approve is on, so the Developer starts on it right after." : "You'll see the updated plan to approve before anything is rewritten."}`,
    );
    launch(botId);
  };

  const begin = (botId: string, brief: string) => {
    setRevision(botId, null);
    change(botId, (p) => {
      p.brief = brief;
      p.status = "planning";
      p.error = null;
      p.note = "The Planner is making the plan.";
      logLine(p, `Brief received: ${clip(brief, 100)}`);
    });
    launch(botId);
  };

  const stop = async (botId: string): Promise<CodingProject> => {
    const project = need(botId);
    // Nothing is running in the other states (a plan waiting for approval waits for you, not for the team).
    if (!isCodingBusy(project.status)) return project;
    // A change the Planner was answering stays saved: Resume carries on with it.
    await halt(botId);
    change(botId, (p) => {
      if (!isCodingBusy(p.status)) return;
      p.status = interruptedStatus(p);
      p.active = null;
      p.note = "Stopped by you.";
      p.cards = p.cards.map((card) => (card.column === "in_progress" ? { ...card, column: "todo" } : card));
      logLine(p, "You stopped the team");
    });
    return need(botId);
  };

  const resume = (botId: string): CodingProject => {
    const project = need(botId);
    if (!["stopped", "needs_you", "error"].includes(project.status))
      throw notAllowed("Only a stopped project, or one waiting for you or in error, can be resumed.");
    if (project.status === "needs_you" && project.round >= project.maxRounds)
      throw notAllowed(
        `The round limit (${project.maxRounds}) is reached. Raise it in the settings, then resume.`,
      );
    const revision = revisionOf(botId);
    const status =
      project.cards.length === 0
        ? project.brief
          ? "planning"
          : "setup"
        : revision
          ? // A change asked for that the Planner hadn't answered when it stopped.
            "planning"
          : project.cards.some((card) => card.column === "todo")
            ? "developing"
            : "qa";
    change(botId, (p) => {
      p.status = status;
      p.error = null;
      p.note =
        status === "setup"
          ? "Waiting for your brief."
          : revision
            ? "Resumed: the Planner carries on with the change you asked for."
            : "Resumed.";
      logLine(p, "You resumed the team");
    });
    if (status !== "setup") launch(botId);
    else say(botId, "Tell me what to build and I'll get the team started.");
    return need(botId);
  };

  /** Checks a model is there, as `race.start` does. Null means the shared model. */
  const checkModel = async (model: string | null | undefined, role: string) => {
    const ref = model ?? runtime.settings.sharedModel;
    if (!ref)
      throw new CodingError(
        `Pick a model for the ${role}, or a shared model in Settings → Local model.`,
        "model_missing",
      );
    if (!(await catalog.info(ref)))
      throw new CodingError(`The model ${ref} isn't available (the ${role}).`, "model_missing");
  };

  const update = async (botId: string, input: UpdateCodingSettingsInput): Promise<CodingProject> => {
    need(botId);
    for (const role of CODING_ROLES) {
      const given = input.roles?.[role];
      if (given && given.model !== undefined) await checkModel(given.model, ROLE_NAMES[role]);
    }
    let approveNow = false;
    change(botId, (p) => {
      if (input.maxRounds !== undefined) p.maxRounds = input.maxRounds;
      if (input.visualQa !== undefined) {
        p.visualQa = input.visualQa;
        logLine(p, `You turned Visual QA ${input.visualQa ? "on" : "off"}`);
      }
      if (input.autoApprove !== undefined) {
        p.autoApprove = input.autoApprove;
        approveNow = input.autoApprove && p.status === "awaiting_approval";
      }
      for (const role of CODING_ROLES) {
        const given = input.roles?.[role];
        if (!given || given.model === undefined) continue;
        p.roles[role].model = given.model;
        const bot = store.bots.update(p.roles[role].botId, { model: given.model });
        if (bot) bus.publish({ type: "bot.updated", bot });
      }
    });
    // Turning auto-approve on while a plan waits is approving it.
    return approveNow ? approve(botId) : need(botId);
  };

  // ---- importing a plan -----------------------------------------------------------------------------------

  interface PlanPreview {
    ok: boolean;
    files: number;
    connections: number;
    errors: string[];
    /** Planned files that are already in the output folder. */
    existing: string[];
    nodes: CodingNode[];
    edges: CodingEdge[];
  }

  /**
   * Takes a plan the user brings (an exported plan file, or a plan inside a chat reply) in place of the Planner's: it is
   * checked exactly as the Planner's is, and when it holds up it becomes the plan waiting for approval, or with
   * auto-approve the work the Developer starts on. No Planner turn is made. `dryRun` only reports what would happen.
   */
  const importPlan = (
    botId: string,
    input: unknown,
    options: { dryRun?: boolean; replace?: boolean },
  ): { preview: PlanPreview; project: CodingProject | null } => {
    const project = need(botId);
    // Any time the team isn't working: a finished project, one in error or waiting for you can start over from a plan.
    if (isCodingBusy(project.status))
      throw notAllowed("A plan can't be brought in while the team is working. Stop the team first.");
    if (project.cards.some((card) => card.column !== "todo") && !options.replace)
      throw Object.assign(
        new CodingError(
          "Some cards have already moved on the board. Bringing in a plan starts them all again from Todo.",
          "needs_replace",
          409,
        ),
        { needsReplace: true },
      );
    const read = readPlanInput(input);
    if (!read)
      throw new CodingError(
        "I couldn't find a plan in that. Send a plan file, or text with the plan's JSON in it.",
      );
    if ("error" in read) throw new CodingError(read.error);
    const checked = validatePlan(read.plan);
    const preview: PlanPreview = checked.ok
      ? {
          ok: true,
          files: checked.nodes.length,
          connections: checked.edges.length,
          errors: [],
          existing: checked.nodes
            .filter((node) => {
              try {
                return statSync(join(project.outputFolder, node.path)).isFile();
              } catch {
                return false;
              }
            })
            .map((node) => node.path),
          nodes: checked.nodes,
          edges: checked.edges,
        }
      : { ok: false, files: 0, connections: 0, errors: checked.errors, existing: [], nodes: [], edges: [] };
    if (!checked.ok || options.dryRun) return { preview, project: null };

    let auto = false;
    // The plan brought in replaces whatever change the Planner was asked for.
    setRevision(botId, null);
    change(botId, (p) => {
      p.nodes = checked.nodes;
      p.edges = checked.edges;
      p.cards = cardsFor(checked.nodes, checked.edges);
      p.round = 0;
      p.error = null;
      p.active = null;
      if (read.brief) p.brief = read.brief;
      else if (!p.brief) p.brief = "(a plan brought in from a file)";
      auto = p.autoApprove;
      p.status = auto ? "developing" : "awaiting_approval";
      p.note = auto
        ? "Plan brought in; auto-approve is on, so the Developer starts."
        : "Plan brought in: approve it or ask for changes.";
      logLine(p, `You brought in a plan: ${checked.nodes.length} files, ${checked.edges.length} connections`);
    });
    say(
      botId,
      `Plan brought in: ${checked.nodes.length} files and ${checked.edges.length} connections.${auto ? " Auto-approve is on, so the Developer starts now." : " Approve it, or tell me what to change."}`,
    );
    if (auto) launch(botId);
    return { preview, project: structuredClone(need(botId)) };
  };

  // ---- the Coding Bot's chat --------------------------------------------------------------------------------

  const status = (p: CodingProject): string => {
    switch (p.status) {
      case "planning":
        return "The Planner is still making the plan; stop it first to change the brief.";
      case "developing":
      case "qa":
        return `The team is working on round ${p.round + 1} of ${p.maxRounds}; stop it first to change the plan.`;
      case "needs_you":
        return `I stopped after round ${p.round} of ${p.maxRounds} with cards still failing. Raise the round limit and resume, or fix them yourself.`;
      case "done":
        return `This project is done: all ${p.cards.length} cards passed QA. The files are in ${p.outputFolder}.`;
      case "error":
        return `I stopped because of a problem: ${p.error ?? "unknown"}. Resume to try again.`;
      default:
        return "The team is stopped. Resume it to carry on.";
    }
  };

  /** What the user typed in the Coding Bot's own chat: the brief, feedback on the plan, or a question about progress. */
  const hear = (botId: string, message: Message) => {
    const project = load(botId);
    if (!project) return;
    const text = messageText(message).trim();
    if (!text) {
      say(botId, "Send your message as text.");
      return;
    }
    // With no plan yet, whatever stopped it (Stop, an error), a message is a new brief.
    if (
      project.status === "setup" ||
      ((project.status === "stopped" || project.status === "error") && project.cards.length === 0)
    ) {
      begin(botId, text);
      return;
    }
    if (project.status === "awaiting_approval") {
      revise(botId, text);
      return;
    }
    if (project.status === "done") {
      changeBuilt(botId, text);
      return;
    }
    say(botId, status(project));
  };

  turns.extensions.handles = (thread, message) => {
    const members = thread.memberIds.flatMap((id) => store.bots.get(id) ?? []);
    const codingBot = members.find((bot) => bot.coding);
    if (thread.kind === "direct" && codingBot) {
      hear(codingBot.id, message);
      return true;
    }
    // The team's work log: nobody answers there, and a role bot's own chat is not for giving it work.
    const team = members.find((bot) => roleOf(bot));
    if (codingBot || team) {
      const owner = codingBot ?? store.bots.get(team!.parentId!);
      if (owner) {
        const reply = store.messages.create({
          threadId: thread.id,
          role: "bot",
          botId: owner.id,
          parts: [
            {
              type: "text",
              text: `${owner.name} runs the team from its own chat. Tell ${owner.name} what you need there; this thread is the team's work log.`,
            },
          ],
        });
        bus.publish({ type: "message.created", message: reply });
      }
      return true;
    }
    return false;
  };

  // ---- creating and deleting --------------------------------------------------------------------------------

  const create = async (input: CreateCodingBotInput): Promise<{ bot: Bot; project: CodingProject }> => {
    const names = Object.fromEntries(
      CODING_ROLES.map((role) => [role, `${input.name} ${ROLE_NAMES[role]}`]),
    ) as Record<CodingRole, string>;
    for (const name of [input.name, ...Object.values(names)]) {
      if (!BotName.safeParse(name).success)
        throw new CodingError(
          "That name is too long: the team's bots are named after it. Use up to 49 characters.",
        );
      if (store.bots.list().some((other) => other.name.toLowerCase() === name.toLowerCase()))
        throw new CodingError(`A bot called “${name}” already exists. Pick another name.`);
    }
    // Every model must be there before anything is made.
    for (const role of CODING_ROLES) await checkModel(input.roles[role].model, ROLE_NAMES[role]);
    const taken = store.bots
      .list()
      .filter((bot) => bot.coding)
      .flatMap((bot) => load(bot.id)?.outputFolder ?? []);
    const outputFolder = checkOutputFolder(input.outputFolder, { dataDir: config.dataDir, taken });

    const codingBot = store.bots.create({
      name: input.name,
      label: "Coding Bot",
      coding: true,
      avatar: CODING_AVATAR,
    });
    const seats = {} as CodingProject["roles"];
    const created: Bot[] = [codingBot];
    const threads: Thread[] = [];
    for (const role of CODING_ROLES) {
      const model = input.roles[role].model ?? null;
      const made = store.bots.create(
        {
          name: names[role],
          label: `${ROLE_NAMES[role]} of ${input.name}`,
          avatar: ROLE_AVATARS[role],
          model,
          tools: { allow: ROLE_ALLOWED[role], exclude: [], apps: {} },
        },
        { parentId: codingBot.id, temporary: false, section: TEAM_SECTION },
      );
      // Every turn of a role is the loop's, not a reply to the user: a desktop notice for each would flood them.
      const hidden = store.bots.update(made.id, { hidden: true, notifications: false }) ?? made;
      created.push(hidden);
      seats[role] = { botId: hidden.id, model };
      // Visible from the start under Bot conversations, even before the role has done anything.
      threads.push(
        store.threads.createGroup(`${input.name} ↔ ${ROLE_NAMES[role]}`, [codingBot.id, hidden.id], {
          pair: true,
        }),
      );
    }
    const project = adopt({
      botId: codingBot.id,
      status: "setup",
      outputFolder,
      roles: seats,
      autoApprove: input.autoApprove ?? false,
      visualQa: input.visualQa ?? false,
      maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS,
      round: 0,
      brief: "",
      nodes: [],
      edges: [],
      cards: [],
      active: null,
      log: [],
      note: "Waiting for your brief.",
      error: null,
      startedAt: now(),
    });
    logLine(project, "Coding Bot created");
    store.settings.set(settingsKey(codingBot.id), project);
    for (const bot of created) {
      bus.publish({ type: "bot.created", bot });
      const own = store.threads.get(bot.threadId);
      if (own) bus.publish({ type: "thread.created", thread: own });
    }
    for (const thread of threads) bus.publish({ type: "thread.created", thread });
    bus.publish({ type: "coding.updated", project: structuredClone(project) });
    say(
      codingBot.id,
      `I'm ${input.name}, a team of a Planner, a Developer and QA. Tell me what to build in a message: I'll plan it${project.autoApprove ? "" : ", show you the plan to approve,"} and write the files into ${outputFolder}.`,
    );
    return { bot: store.bots.get(codingBot.id) ?? codingBot, project: structuredClone(project) };
  };

  // Deleting the Coding Bot takes its team, its state and its chats with it. The output folder is the user's: it is
  // never touched.
  bus.subscribe((event) => {
    if (event.type !== "bot.deleted") return;
    const project = projects.get(event.botId) ?? store.settings.get<CodingProject>(settingsKey(event.botId));
    if (!project) return;
    runs.get(event.botId)?.controller.abort();
    runs.delete(event.botId);
    projects.delete(event.botId);
    store.settings.delete(settingsKey(event.botId));
    store.settings.delete(revisionKey(event.botId));
    for (const role of CODING_ROLES) {
      const botId = project.roles[role].botId;
      folders.delete(botId);
      captures.delete(botId);
      turns.stopBot(botId);
      const roleBot = store.bots.get(botId);
      if (roleBot) delegation.removeBot(roleBot);
    }
  });
  services.disposers.push(() => {
    for (const run of runs.values()) run.controller.abort();
  });

  /** A bot that belongs to a Coding Bot's team (the Coding Bot itself or one of its roles). */
  const isTeamBot = (bot: Bot) => bot.coding || roleOf(bot) !== null;

  return {
    get: (botId: string) => {
      const project = load(botId);
      return project ? structuredClone(project) : null;
    },
    create,
    approve: (botId: string) => structuredClone(approve(botId)),
    revise: (botId: string, request: string) => structuredClone(revise(botId, request)),
    stop: async (botId: string) => structuredClone(await stop(botId)),
    resume: (botId: string) => structuredClone(resume(botId)),
    importPlan,
    /** The clock and the slow-card limits (tests shorten them). */
    timing,
    update: async (botId: string, input: UpdateCodingSettingsInput) =>
      structuredClone(await update(botId, input)),
    isTeamBot,
    /** A Coding Bot's conversation with one of its roles: it can't be deleted or given other members. */
    isTeamThread,
    /** Whether the bot is one of a Coding Bot's role bots (not the Coding Bot itself). */
    isRoleBot: (bot: Bot) => roleOf(bot) !== null,
    /** Resolves when the project's current work has ended (tests). */
    idle: (botId: string) => runs.get(botId)?.done ?? Promise.resolve(),
  };
}

export type Coding = ReturnType<typeof installCoding>;

export function registerCodingRoutes(app: FastifyInstance, services: Services) {
  const { store, coding } = services;

  /** The Coding Bot a route is about, or a 404. */
  const codingBot = (raw: string, reply: Parameters<typeof fail>[0]): Bot | undefined => {
    const id = parse(BotId, raw, reply);
    if (!id) return undefined;
    const bot = store.bots.get(id);
    if (!bot?.coding) {
      void fail(reply, 404, "not_found", "No Coding Bot has this id.");
      return undefined;
    }
    return bot;
  };

  const answer = async (
    reply: Parameters<typeof fail>[0],
    work: () => unknown | Promise<unknown>,
    created = false,
  ) => {
    try {
      const project = await work();
      return created ? reply.code(201).send(project) : { project };
    } catch (error) {
      if (error instanceof CodingError) return fail(reply, error.status, error.code, error.message);
      throw error;
    }
  };

  app.post("/api/coding-bots", async (request, reply) => {
    const input = parse(CreateCodingBotInput, request.body, reply);
    if (!input) return reply;
    return answer(reply, () => coding.create(input), true);
  });

  app.get<{ Params: { id: string } }>("/api/bots/:id/coding", async (request, reply) => {
    const bot = codingBot(request.params.id, reply);
    if (!bot) return reply;
    const project = coding.get(bot.id);
    return project ? { project } : fail(reply, 404, "not_found", "This Coding Bot has no project.");
  });

  app.post<{ Params: { id: string } }>("/api/bots/:id/coding/approve", async (request, reply) => {
    const bot = codingBot(request.params.id, reply);
    return bot ? answer(reply, () => coding.approve(bot.id)) : reply;
  });

  app.post<{ Params: { id: string } }>("/api/bots/:id/coding/revise", async (request, reply) => {
    const bot = codingBot(request.params.id, reply);
    if (!bot) return reply;
    const input = parse(ReviseCodingInput, request.body, reply);
    return input ? answer(reply, () => coding.revise(bot.id, input.note)) : reply;
  });

  app.post<{ Params: { id: string } }>("/api/bots/:id/coding/stop", async (request, reply) => {
    const bot = codingBot(request.params.id, reply);
    return bot ? answer(reply, () => coding.stop(bot.id)) : reply;
  });

  app.post<{ Params: { id: string } }>("/api/bots/:id/coding/resume", async (request, reply) => {
    const bot = codingBot(request.params.id, reply);
    return bot ? answer(reply, () => coding.resume(bot.id)) : reply;
  });

  const ImportInput = z.object({
    plan: z.unknown().refine((value) => value !== undefined && value !== null, "Send the plan."),
    dryRun: z.boolean().optional(),
    replace: z.boolean().optional(),
  });

  // A plan file is small: 2 MB is far more than the largest plan, and keeps a stray big file from being parsed.
  app.post<{ Params: { id: string } }>(
    "/api/bots/:id/coding/import",
    { bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      const bot = codingBot(request.params.id, reply);
      if (!bot) return reply;
      const input = parse(ImportInput, request.body, reply);
      if (!input) return reply;
      try {
        return coding.importPlan(bot.id, input.plan, { dryRun: input.dryRun, replace: input.replace });
      } catch (error) {
        if (!(error instanceof CodingError)) throw error;
        const needsReplace = (error as { needsReplace?: boolean }).needsReplace;
        return reply.code(error.status).send({
          error: error.code,
          message: error.message,
          ...(needsReplace ? { needsReplace: true } : {}),
        });
      }
    },
  );

  app.patch<{ Params: { id: string } }>("/api/bots/:id/coding/settings", async (request, reply) => {
    const bot = codingBot(request.params.id, reply);
    if (!bot) return reply;
    const input = parse(UpdateCodingSettingsInput, request.body, reply);
    return input ? answer(reply, () => coding.update(bot.id, input)) : reply;
  });
}
