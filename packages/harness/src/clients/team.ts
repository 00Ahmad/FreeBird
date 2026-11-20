import { emptyLists, emptyOffer } from "@mrog/clients";
import {
  BotName,
  CLIENT_ROLES,
  DEFAULT_CLIENT_TARGET,
  type Bot,
  type ClientProject,
  type ClientRole,
  type CreateClientBotInput,
  type Thread,
} from "@mrog/shared";

import type { Services } from "../services";
import { ROLES } from "./roles";
import { ClientError, type ClientState } from "./state";

const TEAM_SECTION = "Client team";
export const MAX_CLIENT_NAME = 60 - " Visual helper".length;

/**
 * A Client Bot's team: the Client Bot itself (no model; its chat goes to the client service) and one hidden role bot
 * per role, each with its own pair thread so its work shows under Bot conversations. Deleted with the Client Bot.
 */
export function createClientTeam(services: Services, state: ClientState) {
  const { store, bus, catalog, runtime, delegation } = services;

  const roleOf = (bot: Bot): { clientBot: Bot; role: ClientRole } | null => {
    if (!bot.parentId) return null;
    const clientBot = store.bots.get(bot.parentId);
    if (!clientBot?.client) return null;
    const project = state.load(clientBot.id);
    const role = project && CLIENT_ROLES.find((candidate) => project.roles[candidate].botId === bot.id);
    return role ? { clientBot, role } : null;
  };

  const pairOf = (ownerId: string, roleBotId: string): Thread | undefined =>
    store.threads
      .list()
      .find(
        (thread) =>
          thread.pair &&
          thread.memberIds.length === 2 &&
          thread.memberIds.includes(ownerId) &&
          thread.memberIds.includes(roleBotId),
      );

  const ensurePair = (ownerId: string, roleBot: Bot, role: ClientRole): Thread | undefined => {
    const found = pairOf(ownerId, roleBot.id);
    if (found) return found;
    const owner = store.bots.get(ownerId);
    if (!owner) return undefined;
    const thread = store.threads.createGroup(`${owner.name} ↔ ${ROLES[role].name}`, [ownerId, roleBot.id], {
      pair: true,
    });
    bus.publish({ type: "thread.created", thread });
    return thread;
  };

  const isTeamThread = (thread: Thread) => {
    if (!thread.pair || thread.memberIds.length !== 2) return false;
    const [a, b] = thread.memberIds.map((id) => store.bots.get(id) ?? undefined);
    const role = (bot: Bot | undefined, owner: Bot | undefined) =>
      !!bot && !!owner?.client && roleOf(bot)?.clientBot.id === owner.id;
    return role(a, b) || role(b, a);
  };

  const isTeamBot = (bot: Bot) => bot.client || roleOf(bot) !== null;

  const checkModel = async (model: string | null | undefined, role: string) => {
    const ref = model ?? runtime.settings.sharedModel;
    if (!ref)
      throw new ClientError(
        `Pick a model for the ${role}, or a shared model in Settings → Local model.`,
        "model_missing",
      );
    if (!(await catalog.info(ref)))
      throw new ClientError(`The model ${ref} isn't available (the ${role}).`, "model_missing");
  };

  const create = async (input: CreateClientBotInput): Promise<{ bot: Bot; project: ClientProject }> => {
    const names = Object.fromEntries(
      CLIENT_ROLES.map((role) => [role, `${input.name} ${ROLES[role].name}`]),
    ) as Record<ClientRole, string>;
    for (const name of [input.name, ...Object.values(names)]) {
      if (!BotName.safeParse(name).success)
        throw new ClientError(
          `That name is too long: the team's bots are named after it. Use up to ${MAX_CLIENT_NAME} characters.`,
        );
      if (store.bots.list().some((other) => other.name.toLowerCase() === name.toLowerCase()))
        throw new ClientError(`A bot called “${name}” already exists. Pick another name.`);
    }
    const modelOf = (role: ClientRole) => input.roles?.[role]?.model ?? input.model ?? null;
    for (const role of CLIENT_ROLES) await checkModel(modelOf(role), ROLES[role].name);

    const owner = store.bots.create({
      name: input.name,
      label: "Client Bot",
      client: true,
      avatar: { shape: "burst", color: "amber" },
    });
    const seats = {} as ClientProject["roles"];
    const made: Bot[] = [owner];
    const threads: Thread[] = [];
    for (const role of CLIENT_ROLES) {
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
        { parentId: owner.id, temporary: false, section: TEAM_SECTION },
      );
      const hidden = store.bots.update(bot.id, { hidden: true, notifications: false }) ?? bot;
      made.push(hidden);
      seats[role] = { botId: hidden.id, model };
      threads.push(
        store.threads.createGroup(`${input.name} ↔ ${spec.name}`, [owner.id, hidden.id], { pair: true }),
      );
    }
    const project = state.adopt({
      botId: owner.id,
      status: "interview",
      roles: seats,
      profile: emptyOffer(),
      leads: [],
      seen: [],
      notShown: [],
      registerPages: {},
      deadPages: [],
      searchesRun: [],
      siteNotes: [],
      suggestions: [],
      lists: emptyLists(),
      lookalikes: { clients: [], matched: [], profile: null, approved: false },
      watchOff: false,
      scan: null,
      lastTarget: DEFAULT_CLIENT_TARGET,
      lastKinds: ["asking", "signs", "quiet"],
      askingCount: false,
      interview: { asked: [], skipped: [] },
      active: null,
      handoff: null,
      log: [{ at: state.now(), text: "Client Bot created" }],
      note: "Tell me what you sell and who your ideal client is.",
      error: null,
      startedAt: state.now(),
    });
    for (const bot of made) {
      bus.publish({ type: "bot.created", bot });
      const own = store.threads.get(bot.threadId);
      if (own) bus.publish({ type: "thread.created", thread: own });
    }
    for (const thread of threads) bus.publish({ type: "thread.created", thread });
    return { bot: store.bots.get(owner.id) ?? owner, project: structuredClone(project) };
  };

  const removeTeam = (project: ClientProject) => {
    for (const role of CLIENT_ROLES) {
      const botId = project.roles[role].botId;
      services.turns.stopBot(botId);
      const roleBot = store.bots.get(botId);
      if (roleBot) delegation.removeBot(roleBot);
    }
  };

  return { roleOf, pairOf, ensurePair, isTeamThread, isTeamBot, create, removeTeam };
}

export type ClientTeam = ReturnType<typeof createClientTeam>;
