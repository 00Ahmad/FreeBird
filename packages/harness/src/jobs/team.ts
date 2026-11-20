import { emptyProfile } from "@mrog/jobs";
import {
  BotName,
  DEFAULT_JOB_TARGET,
  JOB_ROLES,
  type Bot,
  type CreateJobBotInput,
  type JobProject,
  type JobRole,
  type Thread,
} from "@mrog/shared";

import type { Services } from "../services";
import { ROLES } from "./roles";
import { JobError, type JobState } from "./state";

const TEAM_SECTION = "Job team";
/** The longest Job Bot name: its role bots are named after it, and "<name> Visual helper" must fit in 60. */
export const MAX_JOB_NAME = 60 - " Visual helper".length;

/**
 * A Job Bot's team: the Job Bot itself (no model; its chat goes to the job service) and one hidden role bot per role,
 * each with its own pair thread so its work shows under Bot conversations. Role bots aren't temporary helpers: never
 * tidied away, never counted as helpers, deleted with the Job Bot.
 */
export function createJobTeam(services: Services, state: JobState) {
  const { store, bus, catalog, runtime, delegation } = services;

  /** The Job Bot a role bot works for, and its role. */
  const roleOf = (bot: Bot): { jobBot: Bot; role: JobRole } | null => {
    if (!bot.parentId) return null;
    const jobBot = store.bots.get(bot.parentId);
    if (!jobBot?.job) return null;
    const project = state.load(jobBot.id);
    const role = project && JOB_ROLES.find((candidate) => project.roles[candidate].botId === bot.id);
    return role ? { jobBot, role } : null;
  };

  const pairOf = (jobBotId: string, roleBotId: string): Thread | undefined =>
    store.threads
      .list()
      .find(
        (thread) =>
          thread.pair &&
          thread.memberIds.length === 2 &&
          thread.memberIds.includes(jobBotId) &&
          thread.memberIds.includes(roleBotId),
      );

  /** The pair thread of a Job Bot and one of its roles, made again if it was deleted. */
  const ensurePair = (jobBotId: string, roleBot: Bot, role: JobRole): Thread | undefined => {
    const found = pairOf(jobBotId, roleBot.id);
    if (found) return found;
    const jobBot = store.bots.get(jobBotId);
    if (!jobBot) return undefined;
    const thread = store.threads.createGroup(`${jobBot.name} ↔ ${ROLES[role].name}`, [jobBotId, roleBot.id], {
      pair: true,
    });
    bus.publish({ type: "thread.created", thread });
    return thread;
  };

  /** A Job Bot's conversation with one of its roles. */
  const isTeamThread = (thread: Thread) => {
    if (!thread.pair || thread.memberIds.length !== 2) return false;
    const [a, b] = thread.memberIds.map((id) => store.bots.get(id) ?? undefined);
    const role = (bot: Bot | undefined, job: Bot | undefined) =>
      !!bot && !!job?.job && roleOf(bot)?.jobBot.id === job.id;
    return role(a, b) || role(b, a);
  };

  /** A bot that belongs to a Job Bot's team (the Job Bot itself or one of its roles). */
  const isTeamBot = (bot: Bot) => bot.job || roleOf(bot) !== null;

  /** Checks a model is there. Null means the shared model. */
  const checkModel = async (model: string | null | undefined, role: string) => {
    const ref = model ?? runtime.settings.sharedModel;
    if (!ref)
      throw new JobError(
        `Pick a model for the ${role}, or a shared model in Settings → Local model.`,
        "model_missing",
      );
    if (!(await catalog.info(ref)))
      throw new JobError(`The model ${ref} isn't available (the ${role}).`, "model_missing");
  };

  const create = async (input: CreateJobBotInput): Promise<{ bot: Bot; project: JobProject }> => {
    const names = Object.fromEntries(
      JOB_ROLES.map((role) => [role, `${input.name} ${ROLES[role].name}`]),
    ) as Record<JobRole, string>;
    for (const name of [input.name, ...Object.values(names)]) {
      if (!BotName.safeParse(name).success)
        throw new JobError(
          `That name is too long: the team's bots are named after it. Use up to ${MAX_JOB_NAME} characters.`,
        );
      if (store.bots.list().some((other) => other.name.toLowerCase() === name.toLowerCase()))
        throw new JobError(`A bot called “${name}” already exists. Pick another name.`);
    }
    const modelOf = (role: JobRole) => input.roles?.[role]?.model ?? input.model ?? null;
    for (const role of JOB_ROLES) await checkModel(modelOf(role), ROLES[role].name);

    const jobBot = store.bots.create({
      name: input.name,
      label: "Job Bot",
      job: true,
      avatar: { shape: "burst", color: "teal" },
    });
    const seats = {} as JobProject["roles"];
    const made: Bot[] = [jobBot];
    const threads: Thread[] = [];
    for (const role of JOB_ROLES) {
      const spec = ROLES[role];
      const model = modelOf(role);
      const bot = store.bots.create(
        {
          name: names[role],
          label: `${spec.name} of ${input.name}`,
          avatar: spec.avatar,
          model,
          visual: spec.visual ?? false,
          tools: { allow: [...spec.tools], exclude: [], apps: {} },
        },
        { parentId: jobBot.id, temporary: false, section: TEAM_SECTION },
      );
      // Every turn of a role is the loop's, not a reply to the user: a desktop notice for each would flood them.
      const hidden = store.bots.update(bot.id, { hidden: true, notifications: false }) ?? bot;
      made.push(hidden);
      seats[role] = { botId: hidden.id, model };
      threads.push(
        store.threads.createGroup(`${input.name} ↔ ${spec.name}`, [jobBot.id, hidden.id], { pair: true }),
      );
    }
    const project = state.adopt({
      botId: jobBot.id,
      status: "interview",
      roles: seats,
      profile: emptyProfile(),
      cards: [],
      seen: [],
      siteNotes: [],
      deadPages: [],
      searchesRun: [],
      interview: { asked: [], skipped: [] },
      suggestions: [],
      scan: null,
      lastTarget: DEFAULT_JOB_TARGET,
      askingCount: false,
      active: null,
      handoff: null,
      log: [{ at: state.now(), text: "Job Bot created" }],
      note: "Tell me about the job you want.",
      error: null,
      startedAt: state.now(),
    });
    for (const bot of made) {
      bus.publish({ type: "bot.created", bot });
      const own = store.threads.get(bot.threadId);
      if (own) bus.publish({ type: "thread.created", thread: own });
    }
    for (const thread of threads) bus.publish({ type: "thread.created", thread });
    return { bot: store.bots.get(jobBot.id) ?? jobBot, project: structuredClone(project) };
  };

  /** Deletes the role bots of a deleted Job Bot (their threads go with them). */
  const removeTeam = (project: JobProject) => {
    for (const role of JOB_ROLES) {
      const botId = project.roles[role].botId;
      services.turns.stopBot(botId);
      const roleBot = store.bots.get(botId);
      if (roleBot) delegation.removeBot(roleBot);
    }
  };

  return { roleOf, ensurePair, isTeamThread, isTeamBot, create, removeTeam };
}

export type JobTeam = ReturnType<typeof createJobTeam>;
