import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { askWith } from "@mrog/engine";
import {
  BotId,
  CreateGroupInput,
  ImportMemoryInput,
  MemoryInput,
  messageText,
  REACTIONS,
  SkillInput,
  ThreadId,
  UpdateGroupInput,
  type Bot,
  type Message,
  type Thread,
} from "@mrog/shared";
import { defineTool, safe } from "@mrog/tools";

import { fail, parse } from "./http";
import type { Services } from "./services";

const MEMORY_IN_PROMPT = 60;
/** How long picking a group chat's responders may take before it falls back to the primary bot. */
const ROUTE_TIMEOUT_MS = 30_000;

const ROUTE_SYSTEM =
  "You pick who answers in a group chat. Reply with only the names of the one or two team members who should answer, comma-separated: no other words.";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `name` as a whole word (case-insensitive; names may contain spaces and punctuation), optionally after "@". */
const wholeWord = (name: string, prefix = "") =>
  new RegExp(`(?<![\\p{L}\\p{N}_@])${prefix}${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, "iu");

/** "@Name" mentions (case-insensitive, names may contain spaces) and "@everyone". */
export function mentionedBots(text: string, members: Bot[]): Bot[] | "everyone" {
  if (wholeWord("everyone", "@").test(text)) return "everyone";
  return members.filter((bot) => wholeWord(bot.name, "@").test(text));
}

/** The members a routing reply names, as whole words, in the order the reply names them. */
function namedIn(reply: string, members: Bot[]): Bot[] {
  return members
    .map((bot) => ({ bot, at: reply.search(wholeWord(bot.name)) }))
    .filter((match) => match.at !== -1)
    .toSorted((a, b) => a.at - b.at)
    .map((match) => match.bot);
}

/**
 * Group chats, memory, skills, reactions and bot-to-bot messages: the parts of the app that make bots a team.
 */
export function installTeam(services: Services) {
  const { store, bus, turns, agent, runtime, registry } = services;

  // ---- who answers in a group --------------------------------------------------------------------------
  /** Ask the shared model which bots should answer; fall back to the primary bot, else the first member. */
  const route = async (thread: Thread, members: Bot[], message: Message): Promise<Bot[]> => {
    const fallback = members.find((bot) => bot.isPrimary) ?? members[0];
    const ref = runtime.settings.sharedModel;
    if (!ref || members.length < 2) return fallback ? [fallback] : [];
    try {
      const { provider, model } = registry.resolve(ref);
      const roster = members
        .map((bot) => `- ${bot.name}: ${bot.label ?? ""} ${bot.instructions.slice(0, 160)}`)
        .join("\n");
      const ask = `Team members:\n${roster}\n\nThe user wrote in the group chat:\n"""${messageText(message).slice(0, 2000)}"""\n\nWhich one or two members should answer? Reply with their names only, comma-separated.`;
      // Covers the wait for the shared-model slot too, behind other bots' requests.
      const signal = AbortSignal.timeout(ROUTE_TIMEOUT_MS);
      const call = () =>
        askWith(provider, model, ROUTE_SYSTEM, ask, {
          signal,
          local: provider.local ? runtime.localOptions() : undefined,
          maxTokens: 60,
        });
      // Only the local model has a shared slot to wait for; a cloud shared model is asked straight away.
      const text = provider.local ? await runtime.run("background", call, { signal }) : await call();
      const picked = namedIn(text, members).slice(0, 2);
      if (picked.length > 0) return picked;
    } catch (error) {
      console.warn(`[team] routing fell back: ${(error as Error).message}`);
    }
    return fallback ? [fallback] : [];
  };

  turns.extensions.responders = async (thread, message) => {
    const members = thread.memberIds.flatMap((id) => store.bots.get(id) ?? []);
    const mentioned = mentionedBots(messageText(message), members);
    if (mentioned === "everyone") return members;
    if (mentioned.length > 0) return mentioned;
    // A reply to a bot's message goes to that bot.
    if (message.replyToId) {
      const original = store.messages.get(message.replyToId);
      const bot = original?.botId ? members.find((member) => member.id === original.botId) : undefined;
      if (bot) return [bot];
    }
    return route(thread, members, message);
  };

  // ---- memory ------------------------------------------------------------------------------------------
  agent.promptSources.push((bot) => ({
    memory: store.memory
      .list(bot.id)
      .slice(-MEMORY_IN_PROMPT)
      .map((note) => note.text),
  }));

  const publishMemory = () => bus.publish({ type: "data.changed", keys: ["memory"] });

  agent.toolSources.push((bot) => [
    defineTool({
      name: "remember",
      description:
        "Save a short note to your long-term memory (preferences, facts about the user, how they like work done). You'll see it in every future conversation.",
      args: z.object({ note: z.string().trim().min(1).max(2000) }),
      risk: (args) => safe(`Remember: ${args.note}`),
      run: async (args) => {
        store.memory.add(bot.id, args.note);
        publishMemory();
        return "Saved to memory.";
      },
    }),
    defineTool({
      name: "forget",
      description: "Delete memory notes that contain the given text.",
      args: z.object({ text: z.string().min(2) }),
      risk: (args) => safe(`Forget notes about: ${args.text}`),
      run: async (args) => {
        const matches = store.memory
          .list(bot.id)
          .filter((note) => note.text.toLowerCase().includes(args.text.toLowerCase()));
        for (const note of matches) store.memory.delete(note.id);
        if (matches.length) publishMemory();
        return matches.length ? `Forgot ${matches.length} note(s).` : "No matching notes.";
      },
    }),
  ]);

  // Bot-to-bot messages and helper bots live in delegation.ts.
}

export function registerTeamRoutes(app: FastifyInstance, services: Services) {
  const { store, bus, turns, agent } = services;

  // ---- group chats ---------------------------------------------------------------------------------------
  /** Distinct, existing members of at least two; undefined after sending a 400. */
  const groupMembers = (ids: string[], reply: Parameters<typeof fail>[0]) => {
    const unique = [...new Set(ids)];
    if (unique.some((id) => !store.bots.get(id))) {
      void fail(reply, 400, "invalid_request", "Unknown bot.");
      return undefined;
    }
    if (unique.length < 2) {
      void fail(reply, 400, "invalid_request", "A group chat needs at least two different bots.");
      return undefined;
    }
    return unique;
  };

  app.post("/api/threads", async (request, reply) => {
    const input = parse(CreateGroupInput, request.body, reply);
    if (!input) return reply;
    const memberIds = groupMembers(input.memberIds, reply);
    if (!memberIds) return reply;
    const thread = store.threads.createGroup(input.title ?? null, memberIds);
    bus.publish({ type: "thread.created", thread });
    return reply.code(201).send({ thread });
  });

  app.patch<{ Params: { id: string } }>("/api/threads/:id", async (request, reply) => {
    const id = parse(ThreadId, request.params.id, reply);
    if (!id) return reply;
    const input = parse(UpdateGroupInput, request.body, reply);
    if (!input) return reply;
    const thread = store.threads.get(id);
    if (!thread) return fail(reply, 404, "not_found", "No thread has this id.");
    if (thread.kind !== "group")
      return fail(reply, 400, "invalid_request", "Only group chats can be changed here.");
    // The Coding Bot hands its roles their work in exactly this thread: other members would break the loop.
    if (input.memberIds && services.coding.isTeamThread(thread))
      return fail(
        reply,
        409,
        "team_thread",
        "This is a Coding Bot's conversation with one of its team: its members can't be changed.",
      );
    if (input.memberIds && services.jobs.isTeamThread(thread))
      return fail(
        reply,
        409,
        "team_thread",
        "This is a Job Bot's conversation with one of its team: its members can't be changed.",
      );
    if (input.memberIds && services.clients.isTeamThread(thread))
      return fail(
        reply,
        409,
        "team_thread",
        "This is a Client Bot's conversation with one of its team: its members can't be changed.",
      );
    const memberIds = input.memberIds && groupMembers(input.memberIds, reply);
    if (input.memberIds && !memberIds) return reply;
    const updated = store.threads.update(id, { ...input, memberIds })!;
    bus.publish({ type: "thread.updated", thread: updated });
    return { thread: updated };
  });

  app.delete<{ Params: { id: string } }>("/api/threads/:id", async (request, reply) => {
    const id = parse(ThreadId, request.params.id, reply);
    if (!id) return reply;
    const thread = store.threads.get(id);
    if (!thread) return fail(reply, 404, "not_found", "No thread has this id.");
    if (thread.kind !== "group")
      return fail(reply, 400, "invalid_request", "Delete the bot to remove its chat.");
    if (services.coding.isTeamThread(thread))
      return fail(
        reply,
        409,
        "team_thread",
        "This is a Coding Bot's conversation with one of its team: it goes when you delete the Coding Bot.",
      );
    if (services.jobs.isTeamThread(thread))
      return fail(
        reply,
        409,
        "team_thread",
        "This is a Job Bot's conversation with one of its team: it goes when you delete the Job Bot.",
      );
    if (services.clients.isTeamThread(thread))
      return fail(
        reply,
        409,
        "team_thread",
        "This is a Client Bot's conversation with one of its team: it goes when you delete the Client Bot.",
      );
    turns.stop(id);
    store.threads.delete(id);
    bus.publish({ type: "thread.deleted", threadId: id });
    // A cluster's experts were made for it and go with it.
    if (thread.cluster) {
      for (const bot of store.bots.list().filter((member) => member.clusterId === id)) {
        turns.stopBot(bot.id);
        store.bots.delete(bot.id);
        bus.publish({ type: "bot.deleted", botId: bot.id });
        bus.publish({ type: "thread.deleted", threadId: bot.threadId });
      }
    }
    return reply.code(204).send();
  });

  // ---- reactions -----------------------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/messages/:id/reactions", async (request, reply) => {
    const body = parse(z.object({ emoji: z.enum(REACTIONS) }), request.body, reply);
    if (!body) return reply;
    const message = store.messages.toggleReaction(request.params.id, body.emoji);
    if (!message) return fail(reply, 404, "not_found", "No message has this id.");
    bus.publish({ type: "message.updated", message });
    return { message };
  });

  // ---- memory ------------------------------------------------------------------------------------------
  const botParam = (id: string, reply: Parameters<typeof fail>[0]) => {
    const botId = parse(BotId, id, reply);
    if (!botId) return undefined;
    if (!store.bots.get(botId)) {
      void fail(reply, 404, "not_found", "No bot has this id.");
      return undefined;
    }
    return botId;
  };
  const memoryChanged = () => bus.publish({ type: "data.changed", keys: ["memory"] });

  app.get<{ Params: { id: string } }>("/api/bots/:id/memory", async (request, reply) => {
    const botId = botParam(request.params.id, reply);
    return botId ? { notes: store.memory.list(botId) } : reply;
  });

  app.post<{ Params: { id: string } }>("/api/bots/:id/memory", async (request, reply) => {
    const botId = botParam(request.params.id, reply);
    if (!botId) return reply;
    const body = parse(MemoryInput, request.body, reply);
    if (!body) return reply;
    const note = store.memory.add(botId, body.text);
    memoryChanged();
    return reply.code(201).send({ note });
  });

  /** "Import from another assistant": one note per line or paragraph. */
  app.post<{ Params: { id: string } }>("/api/bots/:id/memory/import", async (request, reply) => {
    const botId = botParam(request.params.id, reply);
    if (!botId) return reply;
    const body = parse(ImportMemoryInput, request.body, reply);
    if (!body) return reply;
    const lines = body.text
      .split(/\n\s*\n|\n(?=[-*•]\s)/)
      .flatMap((block) => block.split("\n"))
      .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
      .filter((line) => line.length > 2)
      .slice(0, 500);
    for (const line of lines) store.memory.add(botId, line.slice(0, 2000));
    memoryChanged();
    return { added: lines.length };
  });

  app.patch<{ Params: { noteId: string } }>("/api/memory/:noteId", async (request, reply) => {
    const body = parse(MemoryInput, request.body, reply);
    if (!body) return reply;
    const note = store.memory.update(request.params.noteId, body.text);
    if (!note) return fail(reply, 404, "not_found", "No note has this id.");
    memoryChanged();
    return { note };
  });

  app.delete<{ Params: { noteId: string } }>("/api/memory/:noteId", async (request, reply) => {
    if (!store.memory.delete(request.params.noteId))
      return fail(reply, 404, "not_found", "No note has this id.");
    memoryChanged();
    return reply.code(204).send();
  });

  // ---- skills ------------------------------------------------------------------------------------------
  const skillsChanged = () => bus.publish({ type: "data.changed", keys: ["skills"] });

  app.get<{ Querystring: { botId?: string } }>("/api/skills", async (request) => ({
    skills: store.skills.list(request.query.botId),
  }));

  app.post("/api/skills", async (request, reply) => {
    const body = parse(SkillInput, request.body, reply);
    if (!body) return reply;
    if (body.botId && !store.bots.get(body.botId)) return fail(reply, 400, "invalid_request", "Unknown bot.");
    const skill = store.skills.add(body);
    skillsChanged();
    return reply.code(201).send({ skill });
  });

  app.patch<{ Params: { id: string } }>("/api/skills/:id", async (request, reply) => {
    const body = parse(SkillInput.partial(), request.body, reply);
    if (!body) return reply;
    if (body.botId && !store.bots.get(body.botId)) return fail(reply, 400, "invalid_request", "Unknown bot.");
    const skill = store.skills.update(request.params.id, body);
    if (!skill) return fail(reply, 404, "not_found", "No skill has this id.");
    skillsChanged();
    return { skill };
  });

  app.delete<{ Params: { id: string } }>("/api/skills/:id", async (request, reply) => {
    if (!store.skills.delete(request.params.id))
      return fail(reply, 404, "not_found", "No skill has this id.");
    skillsChanged();
    return reply.code(204).send();
  });

  // ---- duplicate & files -------------------------------------------------------------------------------
  /** Copies profile, instructions, model, avatar and its own skills; not history, memory or files. */
  app.post<{ Params: { id: string } }>("/api/bots/:id/duplicate", async (request, reply) => {
    const botId = botParam(request.params.id, reply);
    if (!botId) return reply;
    const source = store.bots.get(botId)!;
    // A copy would have the name and look but none of the team, the project or the output folder.
    if (services.coding.isTeamBot(source))
      return fail(
        reply,
        409,
        "team_member",
        source.coding
          ? "A Coding Bot can't be duplicated: make a new Coding Bot instead."
          : "This bot is part of a Coding Bot's team and can't be duplicated.",
      );
    if (services.jobs.isTeamBot(source))
      return fail(
        reply,
        409,
        "team_member",
        source.job
          ? "A Job Bot can't be duplicated: make a new Job Bot instead."
          : "This bot is part of a Job Bot's team and can't be duplicated.",
      );
    if (services.clients.isTeamBot(source))
      return fail(
        reply,
        409,
        "team_member",
        source.client
          ? "A Client Bot can't be duplicated: make a new Client Bot instead."
          : "This bot is part of a Client Bot's team and can't be duplicated.",
      );
    const copy = store.bots.create({
      name: `${source.name} copy`.slice(0, 60),
      label: source.label,
      avatar: source.avatar,
      model: source.model,
      instructions: source.instructions,
    });
    for (const skill of store.skills.list(source.id).filter((own) => own.botId === source.id)) {
      store.skills.add({ botId: copy.id, name: skill.name, prompt: skill.prompt });
    }
    bus.publish({ type: "bot.created", bot: copy });
    const thread = store.threads.get(copy.threadId);
    if (thread) bus.publish({ type: "thread.created", thread });
    return reply.code(201).send({ bot: copy });
  });

  app.get<{ Params: { id: string } }>("/api/bots/:id/files", async (request, reply) => {
    const botId = botParam(request.params.id, reply);
    if (!botId) return reply;
    const { readdir, stat } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const root = agent.workspaceFor(botId);
    const files: { path: string; size: number; modifiedAt: string }[] = [];
    const walk = async (dir: string, prefix: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= 300) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== ".git")
            await walk(full, `${prefix}${entry.name}/`);
        } else {
          // A broken symlink or a file that's locked or just went shouldn't fail the whole listing.
          const info = await stat(full).catch(() => undefined);
          if (!info) continue;
          files.push({
            path: `${prefix}${entry.name}`,
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          });
        }
      }
    };
    await walk(root, "");
    return { root, files };
  });
}
