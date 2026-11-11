import type { FastifyInstance } from "fastify";

import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  CreateClusterInput,
  DISCUSSION_GOALS,
  DiscussionControl,
  MAX_CLUSTER,
  MIN_CLUSTER,
  ProposeClusterInput,
  messageText,
  StartDiscussionInput,
  SuggestRolesInput,
  ThreadId,
  type Bot,
  type ClusterMember,
  type Discussion,
  type DiscussionGoal,
  type Message,
  type Thread,
} from "@mrog/shared";

import { fail, parse } from "./http";
import type { Services } from "./services";
import {
  askModel,
  charsFor,
  fitTexts,
  lastSection,
  mergeSections,
  sectionGaps,
  templateHeadings,
} from "./reports";
import { mentionedBots } from "./team";

/** Tools a bot keeps while discussing: finding and reading sources, nothing that acts (Visual Bots' too). */
export const DISCUSSION_TOOLS = new Set([
  "web_search",
  "fetch_url",
  "browser_open",
  "browser_read",
  "browser_scroll",
  "browser_back",
  "screen_look",
  "screen_go_to",
  "screen_scroll",
  "screen_back",
  "screen_watch",
]);
/** Enough to search and read two or three sources before answering; more makes every turn take minutes. */
const DISCUSSION_MAX_STEPS = 6;
/**
 * Picking the next speaker or suggesting roles may take this long (counted once Ollama is up, and including
 * loading the model) before a fallback is used.
 */
const MODERATOR_TIMEOUT_MS = 90_000;
/** Of the transcript, at most this many characters go to the moderator. */
const TRANSCRIPT_CHARS = 40_000;
/** Room for the summary itself, and for filling in a section it left out. */
const SUMMARY_TOKENS = 3000;
const REPAIR_TOKENS = (gaps: number) => Math.min(SUMMARY_TOKENS, 600 + 500 * gaps);
/** Tokens kept back from the moderator's context for the summary, the instructions and the list of addresses. */
const SUMMARY_RESERVED = SUMMARY_TOKENS + 3500;
const SUMMARY_SYSTEM =
  "You are the neutral moderator of a discussion between AI bots. Write the final summary for the user. Use only what was said in the transcript: never add facts, numbers or sources that aren't in it, and keep each source with the claim it was given for. Link only to addresses from the list of addresses used in the discussion; if a claim's source isn't in that list, name it and write (no address given). Be concise and finish every section. Use Markdown.";
const settingsKey = (threadId: string) => `discussion:${threadId}`;

const RULES = [
  "Back every claim: either with a source you opened in this discussion or with step-by-step reasoning someone could check. Mark each claim (source: https://…, the full address of the page) or (reasoning). A source without its address doesn't count.",
  "Never invent facts, numbers, studies, quotes or addresses. If you couldn't verify something, say it is unverified. When a claim depends on facts, search first: open one or two good sources, then write.",
  "Only say you checked, opened or read something if you used a tool for it in this turn; otherwise say what your claim rests on.",
  "Research budget: at most 3 lookups (searches or pages) per turn. Don't reopen a source someone already cited unless you are checking it; prefer official or primary sources.",
  "Don't narrate your research (no 'Let me check…'); your message is only your contribution. Don't offer to do more or ask the user what they want next: end with your position.",
  "Answer the others by name: say exactly which claim you challenge or build on, and why. Check their sources and reasoning. Disagree when the evidence says so; agreeing to be polite is a failure.",
  "Add something new every turn: new evidence, a counter-argument, a flaw, or a better option. Don't repeat or summarize what was already said.",
  "Keep it under about 200 words plus sources. Speak only as yourself: never write lines for other bots and never start with a [Name]: prefix.",
];

const SUMMARY_SECTIONS: Record<DiscussionGoal, string> = {
  explore:
    "## Discussion summary\n### Most promising ideas\n(each with why, and the evidence or reasoning given)\n### Weak spots and risks\n### Where they disagreed\n### Sources cited\n(each address with the claim it supports; write None if there were none)\n### Open questions",
  decide:
    "## Discussion summary\n### Recommendation\n(one clear choice, your confidence: high, medium or low, and why)\n### Arguments for and against\n### Where they disagreed\n### Sources cited\n(each address with the claim it supports; write None if there were none)\n### What would change the recommendation",
  research:
    "## Discussion summary\n### What the evidence shows\n(each finding with its source)\n### Disputed or uncertain\n### Claims without a source\n(claims made with neither a source nor checkable reasoning)\n### Sources cited\n(each address with the claim it supports; write None if there were none)\n### Open questions",
};

/** The sections of a goal's summary that `text` lacks or leaves empty. */
export const summaryGaps = (text: string, goal: DiscussionGoal) =>
  sectionGaps(text, templateHeadings(SUMMARY_SECTIONS[goal]));

/** A web address in text; parentheses count only in pairs, so `…/wiki/Mercury_(planet)` stays whole. */
export const URL_PATTERN = /https?:\/\/(?:[^\s<>"'()[\]]|\([^\s<>"'()[\]]*\))+/gi;
/** What clings to the end of an address in prose: punctuation, and the quotes or Markdown marks around it. */
const URL_TAIL = /[.,;:!?`*_"'”’»…。]+$/;
/** An address as written in text, without the punctuation or Markdown marks that follow it. */
export const trimUrl = (url: string) => url.replace(URL_TAIL, "");
/** How addresses are compared: no trailing punctuation, slash or #fragment, any case. */
export const normalizeUrl = (url: string) =>
  trimUrl(url).replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();

/**
 * Keeps only links to addresses the bots really opened or wrote; any other link (a model filling in a
 * plausible-looking address) becomes its label marked "no address given".
 */
export function keepKnownLinks(markdown: string, known: Set<string>): string {
  const kept: string[] = [];
  // Checked links are set aside so the bare-address pass below doesn't touch them.
  const hold = (text: string) => `⟦${kept.push(text) - 1}⟧`;
  const linked = markdown
    // A placeholder the model typed itself would be swapped for a link or "undefined".
    .replace(/[⟦⟧]/g, "")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/gi,
      (link, label: string, url: string) =>
        known.has(normalizeUrl(url)) ? hold(link) : `${label} (no address given)`,
    );
  const bare = linked.replace(URL_PATTERN, (url) => {
    if (known.has(normalizeUrl(url))) return url;
    // The marks closing a `code span`, **bold** or quote around it stay, so the text around stays balanced.
    const closing = url.slice(trimUrl(url).length).replace(/[^`*_"'”’»]/g, "");
    return `(no address given)${closing}`;
  });
  return bare.replace(/⟦(\d+)⟧/g, (_, index: string) => kept[Number(index)]!);
}

interface Live {
  state: Discussion;
  controller: AbortController;
  /** What the moderator asked the current speaker to address. */
  focus: string | null;
  /** A bot the user mentioned mid-discussion, who speaks next. */
  next: string | null;
  /** The user wrote since the last turn; the next speaker answers it first. */
  userWrote: boolean;
  /** Run one turn, then pause again (step-by-step). */
  stepOnce: boolean;
  /** Write the summary after the current turn instead of finishing the rounds. */
  finishEarly: boolean;
  /** Wakes the loop while it waits on a pause. */
  wake: (() => void) | null;
}

/** "Name: role" lines (bullets and bold allowed) matched to the members. */
export function parseRoles(text: string, members: Bot[]): Record<string, string> {
  const roles: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw
      .replace(/^[\s>*\-•\d.)]+/, "")
      .replaceAll("**", "")
      .trim();
    // "Name: role", or "Name — role" (a spaced dash, so hyphenated names stay whole).
    const colon = line.indexOf(":");
    const dash = /\s[—–-]\s/.exec(line);
    const at = colon > 0 ? colon : (dash?.index ?? -1);
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const role = line.slice(at + (colon > 0 ? 1 : dash![0].length)).trim();
    const bot = members.find((member) => member.name.toLowerCase() === name);
    if (bot && role && !roles[bot.id]) roles[bot.id] = role.slice(0, 300);
  }
  return roles;
}

/** "Name | Expertise | Personality" lines (Markdown table rows too) as up to five distinct experts. */
function parseTeam(text: string): ClusterMember[] {
  const team: ClusterMember[] = [];
  for (const raw of text.split("\n")) {
    const cells = raw
      .replace(/^[\s>*•\d.)-]+(?=\S)/, "")
      .replaceAll("**", "")
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length < 3) continue;
    const [first, expertise, ...rest] = cells as [string, string, ...string[]];
    const name = first
      .replace(/[^\p{L}\p{N} .'-]/gu, "")
      .trim()
      .slice(0, 40);
    // A table's header or separator row.
    if (!name || /^name$/i.test(name) || /^:?-+:?$/.test(first)) continue;
    if (team.some((member) => member.name.toLowerCase() === name.toLowerCase())) continue;
    team.push({ name, expertise: expertise.slice(0, 80), personality: rest.join(" ").slice(0, 1500) });
  }
  return team.slice(0, MAX_CLUSTER);
}

/** A cluster's name from its topic: the first words, without a trailing question mark. */
export function clusterTitle(topic: string): string {
  const clean = topic
    .replace(/\s+/g, " ")
    .replace(/[?.!]+$/, "")
    .trim();
  return clean.length <= 60 ? clean : `${clean.slice(0, 57).replace(/\s+\S*$/, "")}…`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The bot named first in `text`, by whole name ("Al" isn't in "total"); where two names start at the same place,
 * the longer one ("Ada Lovelace" over "Ada").
 */
export function firstNamed(text: string, bots: Bot[]): Bot | null {
  let best: { bot: Bot; at: number } | null = null;
  for (const bot of bots) {
    const at = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(bot.name)}(?![\\p{L}\\p{N}])`, "iu").exec(
      text,
    )?.index;
    if (at === undefined) continue;
    if (!best || at < best.at || (at === best.at && bot.name.length > best.bot.name.length))
      best = { bot, at };
  }
  return best?.bot ?? null;
}

/** The text after a "Label:" line, with Markdown emphasis around the label allowed (`**NEXT:** Bea`). */
export const labelled = (text: string, label: string) =>
  new RegExp(`(?<![\\p{L}])${label}[*_\\s]*[:：][*_\\s]*([^\\n]+)`, "iu").exec(text)?.[1];

/** The moderator's "NEXT: name / FOCUS: point" reply. */
export function parseNext(text: string, candidates: Bot[]): { bot: Bot; focus: string | null } | null {
  const next = labelled(text, "NEXT") ?? text;
  const focus =
    labelled(text, "FOCUS")
      ?.replace(/[*_]+$/, "")
      .trim() || null;
  const bot = firstNamed(next, candidates);
  return bot ? { bot, focus: focus?.slice(0, 300) ?? null } : null;
}

/**
 * Group discussions: bots take turns on a topic for a few rounds, each backing its claims with sources or
 * reasoning and answering the others; a moderator (the shared model) picks who speaks next and writes the summary.
 */
export function installDiscussions(services: Services) {
  const { store, bus, turns, agent, runtime, registry } = services;
  const live = new Map<string, Live>();

  const publish = (state: Discussion) => {
    store.settings.set(settingsKey(state.threadId), state);
    bus.publish({ type: "discussion.updated", discussion: { ...state } });
  };

  const get = (threadId: string): Discussion | null => {
    const running = live.get(threadId);
    if (running) return running.state;
    const saved = store.settings.get<Discussion>(settingsKey(threadId));
    // One that was running when the app closed didn't finish.
    if (saved && (saved.status === "running" || saved.status === "summarizing"))
      return { ...saved, status: "stopped", speakerId: null };
    return saved ?? null;
  };

  const isRunning = (threadId: string) => live.has(threadId);

  const members = (thread: Thread): Bot[] => {
    const fresh = store.threads.get(thread.id) ?? thread;
    return fresh.memberIds.flatMap((id) => store.bots.get(id) ?? []);
  };

  const moderatorModel = (team: Bot[]) => {
    const ref = runtime.settings.sharedModel ?? team.find((bot) => bot.model)?.model;
    if (!ref)
      throw Object.assign(new Error("Pick a shared model in Settings → Local model first."), {
        code: "model_missing",
      });
    return { ref, ...registry.resolve(ref) };
  };

  /** One call to the moderator model, no tools. */
  const ask = async (
    team: Bot[],
    system: string,
    user: string,
    options: { signal: AbortSignal; maxTokens: number; timeoutMs?: number; onText?: (text: string) => void },
  ): Promise<string> => (await askModel(services, moderatorModel(team).ref, system, user, options)).text;

  /**
   * The discussion so far, fitted to what the moderator's model can read with `reserved` tokens kept back: every
   * turn keeps its start, so the openings aren't lost to a long last round.
   */
  const transcript = (state: Discussion, team: Bot[], reserved: number): string => {
    const names = new Map(store.bots.list().map((bot) => [bot.id, bot.name]));
    const said = store.messages
      .list(state.threadId, { limit: 400 })
      .filter(
        (message) =>
          message.createdAt >= state.startedAt && message.role !== "system" && message.id !== state.summaryId,
      )
      .map((message) => {
        // A deleted expert's messages lose their bot; only the moderator's summary is meant to have none.
        const who =
          message.role === "user"
            ? "User"
            : (message.botId && names.get(message.botId)) ||
              (message.moderator ? "Moderator" : "A former expert");
        const text = messageText(message).trim();
        return text ? `[${who}]: ${text.slice(0, 3000)}` : "";
      })
      .filter(Boolean);
    const local = moderatorModel(team).provider.local;
    const budget = local
      ? Math.min(TRANSCRIPT_CHARS, charsFor(runtime.settings.numCtx, reserved))
      : TRANSCRIPT_CHARS;
    return fitTexts(said, budget).join("\n\n");
  };

  /** Every address the bots opened, found in results, or wrote during the discussion, with who used it. */
  const sources = (state: Discussion): Map<string, { url: string; by: Set<string> }> => {
    const names = new Map(store.bots.list().map((bot) => [bot.id, bot.name]));
    const found = new Map<string, { url: string; by: Set<string> }>();
    const add = (url: string, who: string) => {
      const key = normalizeUrl(url);
      const entry = found.get(key) ?? { url: trimUrl(url), by: new Set<string>() };
      entry.by.add(who);
      found.set(key, entry);
    };
    // Links the user gave count too, so a summary citing them keeps them.
    for (const url of state.topic.match(URL_PATTERN) ?? []) add(url, "the user");
    for (const message of store.messages.list(state.threadId, { limit: 400 })) {
      if (message.createdAt < state.startedAt) continue;
      if (message.role === "user") {
        for (const part of message.parts)
          if (part.type === "text")
            for (const url of part.text.match(URL_PATTERN) ?? []) add(url, "the user");
        continue;
      }
      // The moderator's own summary isn't a source.
      if (message.role !== "bot" || message.moderator) continue;
      const who = (message.botId && names.get(message.botId)) || "a former expert";
      for (const part of message.parts) {
        if (part.type === "text") for (const url of part.text.match(URL_PATTERN) ?? []) add(url, who);
        if (part.type !== "tool") continue;
        if (typeof part.args.url === "string") add(part.args.url, who);
        for (const url of (part.result ?? "").match(URL_PATTERN)?.slice(0, 30) ?? []) add(url, who);
      }
    }
    return found;
  };

  const roster = (team: Bot[], roles: Record<string, string>) =>
    team
      .map((bot) => {
        const about = [bot.label, bot.instructions.slice(0, 200)].filter(Boolean).join(". ");
        const role = roles[bot.id];
        return `- ${bot.name}${role ? ` (role: ${role})` : ""}${about ? `: ${about}` : ""}`;
      })
      .join("\n");

  const suggestRoles = async (
    team: Bot[],
    topic: string,
    goal: DiscussionGoal,
    signal: AbortSignal,
  ): Promise<Record<string, string>> => {
    const text = await ask(
      team,
      "You set up discussions between AI bots. Answer exactly in the format asked, nothing else.",
      `Topic: ${topic}\nGoal: ${DISCUSSION_GOALS[goal].description}\n\nMembers:\n${roster(team, {})}\n\nGive each member a distinct role or stance for this discussion, so together they cover the topic well and challenge each other. One of them should be a skeptic who checks the others' evidence. Fit roles to what each member is about where you can. Reply with one line per member, exactly "Name: role" (at most 20 words each).`,
      { signal, timeoutMs: MODERATOR_TIMEOUT_MS, maxTokens: 400 },
    );
    return parseRoles(text, team);
  };

  const pickSpeaker = async (
    entry: Live,
    team: Bot[],
    remaining: Bot[],
  ): Promise<{ bot: Bot; focus: string | null }> => {
    const { state } = entry;
    const userFocus = entry.userWrote ? "Answer the user's latest message first, then go on." : null;
    entry.userWrote = false;
    const mentioned = entry.next ? team.find((bot) => bot.id === entry.next) : undefined;
    entry.next = null;
    if (mentioned) return { bot: mentioned, focus: userFocus };
    // Openings go in order; later turns go to whoever most needs to answer.
    if (state.round === 1 || remaining.length === 1) return { bot: remaining[0]!, focus: userFocus };
    try {
      const text = await ask(
        team,
        "You moderate a discussion between AI bots. Answer exactly in the format asked, nothing else.",
        `Topic: ${state.topic}\nGoal: ${DISCUSSION_GOALS[state.goal].description}\n\nTranscript so far:\n${transcript(state, team, 1500)}\n\nNot yet spoken this round:\n${roster(remaining, state.roles)}\n\nWho should speak next? Prefer someone whose claim was just challenged, or who can best answer the strongest open point or a claim that lacks evidence. Reply exactly:\nNEXT: <name>\nFOCUS: <one sentence: the specific point they should answer>`,
        {
          signal: entry.controller.signal,
          timeoutMs: MODERATOR_TIMEOUT_MS,
          maxTokens: 120,
        },
      );
      const picked = parseNext(text, remaining);
      if (picked) return { bot: picked.bot, focus: userFocus ?? picked.focus };
    } catch (error) {
      if (entry.controller.signal.aborted) throw error;
      console.warn(`[discussion] picking the next speaker fell back: ${(error as Error).message}`);
    }
    return { bot: remaining[0]!, focus: userFocus };
  };

  /**
   * The moderator's summary, streamed into its own message. A section the model left out, left empty or was cut off
   * in is asked for once more and put in its place, so the report ends whole. `ended`: why the discussion stopped
   * before its last round, for the summary to say.
   */
  const summarize = async (entry: Live, thread: Thread, team: Bot[], ended: string | null = null) => {
    const { state, controller } = entry;
    let message: Message | undefined;
    let text = "";
    let status: Message["status"] = "done";
    let known = new Set<string>();
    // The message and the "working" mark are set up inside the try, so a failure while preparing still clears them.
    try {
      const { ref } = moderatorModel(team);
      const started = store.messages.create({
        threadId: thread.id,
        role: "bot",
        botId: null,
        moderator: true,
        parts: [],
        status: "streaming",
        model: ref,
      });
      message = started;
      bus.publish({ type: "message.created", message: started });
      state.summaryId = started.id;
      publish(state);
      turns.setActivity(thread.id, null, "working");
      const used = sources(state);
      known = new Set(used.keys());
      const list =
        [...used.values()]
          .slice(0, 80)
          .map((source) => `- ${source.url} (${[...source.by].join(", ")})`)
          .join("\n") || "(none)";
      const early = ended
        ? `\n\nThe discussion ended early (${ended}); summarize what was said and say that it ended early.`
        : "";
      const about = `Topic: ${state.topic}\nGoal: ${DISCUSSION_GOALS[state.goal].description}${early}\n\nTranscript:\n${transcript(state, team, SUMMARY_RESERVED)}\n\nAddresses used in the discussion:\n${list}`;
      const headings = templateHeadings(SUMMARY_SECTIONS[state.goal]);
      const write = () =>
        askModel(
          services,
          ref,
          SUMMARY_SYSTEM,
          `${about}\n\nWrite the summary with exactly these sections:\n${SUMMARY_SECTIONS[state.goal]}`,
          {
            signal: controller.signal,
            maxTokens: SUMMARY_TOKENS,
            onText: (chunk) => {
              text += chunk;
              bus.publish({
                type: "message.delta",
                threadId: thread.id,
                messageId: started.id,
                partIndex: 0,
                kind: "text",
                text: chunk,
              });
            },
          },
        );
      // A call that failed before writing anything (the model server hiccuped) is tried once more.
      const first = await write().catch((error: unknown) => {
        if (controller.signal.aborted || text) throw error;
        console.warn(`[discussion] the summary failed, trying again: ${(error as Error).message}`);
        return write();
      });
      const gaps = sectionGaps(text, headings);
      const last = first.cut ? lastSection(text, headings) : null;
      if (last && !gaps.includes(last)) gaps.push(last);
      if (gaps.length > 0 && !controller.signal.aborted) {
        const more = await askModel(
          services,
          ref,
          SUMMARY_SYSTEM,
          `${about}\n\nThe summary so far:\n${text}\n\nThese sections are missing, empty or cut off: ${gaps.join(", ")}. Write only those sections, each under its ### heading, in full and from the transcript.`,
          { signal: controller.signal, maxTokens: REPAIR_TOKENS(gaps.length) },
        ).catch((error: unknown) => {
          if (controller.signal.aborted) throw error;
          console.warn(`[discussion] filling the summary's gaps failed: ${(error as Error).message}`);
          return null;
        });
        if (more) text = mergeSections(text, more.text, gaps, headings);
      }
    } catch (error) {
      status = controller.signal.aborted ? "stopped" : "error";
      if (status === "error") throw error;
    } finally {
      if (message) {
        // Streamed as written; saved with any made-up links taken out.
        text = keepKnownLinks(text, known);
        const parts = text ? [{ type: "text" as const, text }] : [];
        const saved = store.messages.update(message.id, { parts, status });
        if (saved) bus.publish({ type: "message.updated", message: saved });
      }
      if (!turns.isBusy(thread.id)) turns.setActivity(thread.id, null, "idle");
    }
  };

  const run = async (entry: Live, thread: Thread) => {
    const { state, controller } = entry;
    const signal = controller.signal;
    const end = (status: Discussion["status"], error: string | null = null) => {
      state.status = status;
      state.error = error;
      state.speakerId = null;
    };
    // Holds before the next turn while paused; Resume, Next turn, Finish or Stop wake it.
    const hold = async () => {
      while (state.paused && !signal.aborted && !entry.finishEarly) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            signal.removeEventListener("abort", wake);
            resolve();
          };
          entry.wake = wake;
          signal.addEventListener("abort", wake, { once: true });
        });
      }
    };
    try {
      let failures = 0;
      let delivered = 0;
      // Why the bots couldn't go on; with turns already spoken, the summary still covers them.
      let failed: string | null = null;
      rounds: for (let round = 1; round <= state.rounds; round += 1) {
        state.round = round;
        state.spoken = [];
        // Who has yet to speak this round, by id. The team is read again before every turn, so an expert deleted
        // meanwhile is skipped instead of being picked.
        const waiting = new Set(members(thread).map((bot) => bot.id));
        while (waiting.size > 0) {
          await hold();
          if (signal.aborted) return end("stopped");
          if (entry.finishEarly) break rounds;
          const team = members(thread);
          const remaining = team.filter((member) => waiting.has(member.id));
          if (remaining.length === 0) break;
          if (team.length < 2) {
            const reason = "A discussion needs at least two bots.";
            if (delivered === 0) return end("error", reason);
            failed = reason;
            break rounds;
          }
          const { bot, focus } = await pickSpeaker(entry, team, remaining);
          waiting.delete(bot.id);
          entry.focus = focus;
          state.speakerId = bot.id;
          publish(state);
          let reply: Message;
          try {
            reply = await turns.start(store.threads.get(thread.id) ?? thread, bot, "user");
          } catch (error) {
            entry.focus = null;
            // Deleted after being picked: it can't speak, and the others go on.
            if (!store.bots.get(bot.id)) continue;
            throw error;
          }
          entry.focus = null;
          if (signal.aborted) return end("stopped");
          // Deleting the speaker stops its turn; that ends its turn, not the discussion.
          if (!store.bots.get(bot.id)) {
            if (messageText(reply).trim()) delivered += 1;
            continue;
          }
          if (reply.status === "stopped") return end("stopped");
          state.spoken = [...state.spoken, bot.id];
          publish(state);
          if (entry.stepOnce) {
            entry.stepOnce = false;
            state.paused = true;
            state.speakerId = null;
            publish(state);
          }
          if (reply.status === "error") {
            const part = reply.parts.find((p) => p.type === "error");
            // A missing model fails every turn the same way.
            if ((part?.type === "error" && part.code === "model_missing") || ++failures >= 3) {
              failed = part?.type === "error" ? part.message : "The bots' replies kept failing.";
              if (delivered === 0) return end("error", failed);
              break rounds;
            }
          } else if (messageText(reply).trim()) {
            delivered += 1;
            // Only failures in a row mean the bots can't go on.
            failures = 0;
          }
        }
      }
      state.status = "summarizing";
      state.speakerId = null;
      state.paused = false;
      publish(state);
      await summarize(entry, thread, members(thread), failed);
      // Ended early by a failure: the report is there, and the reason stays shown with it.
      end(signal.aborted ? "stopped" : "done", signal.aborted ? null : failed);
    } catch (error) {
      if (signal.aborted) end("stopped");
      else {
        console.error("[discussion] failed", error);
        end("error", (error as Error).message);
      }
    } finally {
      live.delete(thread.id);
      publish(state);
    }
  };

  const start = async (thread: Thread, input: StartDiscussionInput): Promise<Discussion> => {
    const team = members(thread);
    moderatorModel(team);
    const controller = new AbortController();
    const state: Discussion = {
      threadId: thread.id,
      topic: input.topic,
      goal: input.goal,
      rounds: input.rounds,
      roles: {},
      round: 0,
      speakerId: null,
      spoken: [],
      status: "running",
      paused: false,
      error: null,
      summaryId: null,
      startedAt: new Date().toISOString(),
    };
    const entry: Live = {
      state,
      controller,
      focus: null,
      next: null,
      userWrote: false,
      stepOnce: false,
      finishEarly: false,
      wake: null,
    };
    live.set(thread.id, entry);
    publish(state);

    void (async () => {
      const given = Object.fromEntries(
        team.flatMap((bot) => (input.roles[bot.id]?.trim() ? [[bot.id, input.roles[bot.id]!.trim()]] : [])),
      );
      let roles = given;
      if (team.some((bot) => !given[bot.id])) {
        const suggested = await suggestRoles(team, input.topic, input.goal, controller.signal).catch(
          () => ({}),
        );
        roles = { ...suggested, ...given };
      }
      state.roles = roles;
      // Everyone sees the topic and the roles as a note from the app.
      const note = store.messages.create({
        threadId: thread.id,
        role: "system",
        parts: [
          {
            type: "text",
            text: `Discussion: ${input.topic}\n${DISCUSSION_GOALS[input.goal].label} · ${input.rounds} round${input.rounds === 1 ? "" : "s"}\n${team
              .map((bot) => `${bot.name}: ${roles[bot.id] ?? "speaks from their own expertise"}`)
              .join("\n")}`,
          },
        ],
      });
      bus.publish({ type: "message.created", message: note });
      await run(entry, thread);
    })().catch((error: unknown) => {
      console.error("[discussion] failed to start", error);
      live.delete(thread.id);
      state.status = "error";
      state.error = (error as Error).message;
      publish(state);
    });
    return state;
  };

  /** Pause, resume, one step at a time, or finish early; false when no discussion is running. */
  const control = (threadId: string, action: DiscussionControl["action"]): boolean => {
    const entry = live.get(threadId);
    if (!entry || entry.state.status !== "running") return false;
    const { state } = entry;
    state.paused = action === "pause";
    entry.stepOnce = action === "step";
    if (action === "finish") entry.finishEarly = true;
    entry.wake?.();
    entry.wake = null;
    publish(state);
    return true;
  };

  /** 3–5 experts this topic needs, each with an expertise and a personality, for the user to review. */
  const proposeTeam = async (input: ProposeClusterInput, signal: AbortSignal): Promise<ClusterMember[]> => {
    const requestTeam = (extra: string) =>
      ask(
        [],
        "You assemble expert panels for discussions between AI bots. Answer exactly in the format asked, nothing else.",
        `Topic: ${input.topic}\nGoal: ${DISCUSSION_GOALS[input.goal].description}\n\nPropose the ${MIN_CLUSTER} to ${MAX_CLUSTER} experts this topic needs (fewer when it is narrow). Give them different backgrounds and points of view so they challenge each other; one should be a skeptic who checks the evidence. Reply with one line per expert, exactly:\nName | Expertise (2 to 6 words) | Personality and point of view on this topic (1 or 2 sentences)\nUse short, distinct first names.${extra}`,
        { signal, timeoutMs: MODERATOR_TIMEOUT_MS * 2, maxTokens: 800 },
      );
    let team = parseTeam(await requestTeam(""));
    if (team.length < MIN_CLUSTER)
      team = parseTeam(
        await requestTeam(`\nGive at least ${MIN_CLUSTER} lines, each with two | separators.`),
      );
    if (team.length < MIN_CLUSTER)
      throw Object.assign(
        new Error("The model didn't propose a team. Try again, or add the experts yourself."),
        {
          code: "bad_output",
        },
      );
    return team.map((member, i) => ({ ...member, color: AVATAR_COLORS[i % AVATAR_COLORS.length] }));
  };

  /** Makes the experts (bots that live only in this cluster), the cluster itself, and starts its discussion. */
  const createCluster = async (
    input: CreateClusterInput,
  ): Promise<{ thread: Thread; discussion: Discussion }> => {
    moderatorModel([]);
    const draft = store.threads.createGroup(input.title?.trim() || clusterTitle(input.topic), [], {
      cluster: true,
    });
    const team = input.members.map((member, i) =>
      store.bots.create(
        {
          name: member.name,
          label: member.expertise,
          avatar: {
            shape: AVATAR_SHAPES[i % AVATAR_SHAPES.length]!,
            color: member.color ?? AVATAR_COLORS[i % AVATAR_COLORS.length]!,
          },
          model: member.model ?? null,
          instructions: `You are ${member.name}, ${member.expertise}. ${member.personality}\n\nYou were brought in for a discussion about: "${input.topic}". Speak from your expertise and personality.`,
        },
        undefined,
        draft.id,
      ),
    );
    const thread = store.threads.update(draft.id, { memberIds: team.map((bot) => bot.id) })!;
    for (const bot of team) bus.publish({ type: "bot.created", bot });
    bus.publish({ type: "thread.created", thread });
    const roles = Object.fromEntries(
      team.map((bot, i) => [
        bot.id,
        `${input.members[i]!.expertise} — ${input.members[i]!.personality}`.slice(0, 300),
      ]),
    );
    const discussion = await start(thread, {
      topic: input.topic,
      goal: input.goal,
      rounds: input.rounds,
      roles,
    });
    return { thread, discussion };
  };

  const stop = (threadId: string): boolean => {
    const entry = live.get(threadId);
    if (!entry) return false;
    entry.controller.abort();
    turns.stop(threadId);
    return true;
  };

  // ---- hooks into chat turns ----------------------------------------------------------------------------
  // While discussing, the user's messages go to the next speaker instead of starting replies of their own.
  const routeNormally = turns.extensions.responders;
  turns.extensions.responders = async (thread, message) => {
    const entry = live.get(thread.id);
    if (!entry) return (await routeNormally?.(thread, message)) ?? [];
    const mentioned = mentionedBots(messageText(message), members(thread));
    if (mentioned !== "everyone" && mentioned.length > 0) entry.next = mentioned[0]!.id;
    entry.userWrote = true;
    return [];
  };

  agent.toolFilters.push((_bot, thread, specs) =>
    live.has(thread.id) ? specs.filter((spec) => DISCUSSION_TOOLS.has(spec.name)) : specs,
  );

  const baseOptions = turns.extensions.turnOptions;
  turns.extensions.turnOptions = (bot, thread, info) => {
    const options = baseOptions?.(bot, thread, info) ?? {};
    if (!live.has(thread.id)) return options;
    return {
      ...options,
      maxSteps: Math.min(options.maxSteps ?? DISCUSSION_MAX_STEPS, DISCUSSION_MAX_STEPS),
      selfCheck: false,
      stepLimitNote: false,
    };
  };

  agent.promptSources.push((bot, thread) => {
    const entry = live.get(thread.id);
    if (!entry) return {};
    const { state } = entry;
    const lines = [
      `You are taking part in a structured discussion with the other bots in this group about: "${state.topic}".`,
      `Goal: ${DISCUSSION_GOALS[state.goal].description}`,
      `Your role: ${state.roles[bot.id] ?? "speak from your own expertise"}. Argue from this role.`,
      `Rules:\n${RULES.map((rule) => `- ${rule}`).join("\n")}`,
      state.round <= 1
        ? `Round 1 of ${state.rounds}: give your opening position, with your strongest evidence.`
        : state.round === state.rounds
          ? `Round ${state.round} of ${state.rounds}, the last: answer the strongest point against you, then state your final position and what would change your mind.`
          : `Round ${state.round} of ${state.rounds}.`,
    ];
    if (entry.focus && state.speakerId === bot.id)
      lines.push(`The moderator asks you to address: ${entry.focus}`);
    return { extra: [lines.join("\n\n")] };
  });

  bus.subscribe((event) => {
    if (event.type !== "thread.deleted") return;
    stop(event.threadId);
    store.settings.delete(settingsKey(event.threadId));
  });
  services.disposers.push(() => {
    for (const entry of live.values()) entry.controller.abort();
  });

  return { get, isRunning, start, stop, control, suggestRoles, members, proposeTeam, createCluster };
}

export type Discussions = ReturnType<typeof installDiscussions>;

export function registerDiscussionRoutes(app: FastifyInstance, services: Services) {
  const { store, turns, discussions } = services;

  const groupThread = (raw: string, reply: Parameters<typeof fail>[0]): Thread | undefined => {
    const id = parse(ThreadId, raw, reply);
    if (!id) return undefined;
    const thread = store.threads.get(id);
    if (!thread) {
      void fail(reply, 404, "not_found", "No thread has this id.");
      return undefined;
    }
    if (thread.kind !== "group") {
      void fail(reply, 400, "not_a_group", "Discussions happen in group chats.");
      return undefined;
    }
    return thread;
  };

  app.get<{ Params: { id: string } }>("/api/threads/:id/discussion", async (request, reply) => {
    const thread = groupThread(request.params.id, reply);
    if (!thread) return reply;
    return { discussion: discussions.get(thread.id) };
  });

  app.post<{ Params: { id: string } }>("/api/threads/:id/discussion", async (request, reply) => {
    const thread = groupThread(request.params.id, reply);
    if (!thread) return reply;
    const input = parse(StartDiscussionInput, request.body, reply);
    if (!input) return reply;
    if (discussions.isRunning(thread.id))
      return fail(reply, 409, "already_running", "A discussion is already running in this chat.");
    if (turns.isBusy(thread.id))
      return fail(reply, 409, "busy", "Wait for the current replies to finish, or stop them first.");
    if (discussions.members(thread).length < 2)
      return fail(reply, 400, "too_few_bots", "A discussion needs at least two bots.");
    try {
      return reply.code(201).send({ discussion: await discussions.start(thread, input) });
    } catch (error) {
      return fail(
        reply,
        400,
        (error as { code?: string }).code ?? "invalid_request",
        (error as Error).message,
      );
    }
  });

  app.post<{ Params: { id: string } }>("/api/threads/:id/discussion/stop", async (request, reply) => {
    const thread = groupThread(request.params.id, reply);
    if (!thread) return reply;
    discussions.stop(thread.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/threads/:id/discussion/control", async (request, reply) => {
    const thread = groupThread(request.params.id, reply);
    if (!thread) return reply;
    const input = parse(DiscussionControl, request.body, reply);
    if (!input) return reply;
    if (!discussions.control(thread.id, input.action))
      return fail(reply, 409, "not_running", "No discussion is running in this chat.");
    return { discussion: discussions.get(thread.id) };
  });

  app.post("/api/clusters/propose", async (request, reply) => {
    const input = parse(ProposeClusterInput, request.body, reply);
    if (!input) return reply;
    try {
      return { members: await discussions.proposeTeam(input, new AbortController().signal) };
    } catch (error) {
      return fail(reply, 503, (error as { code?: string }).code ?? "unavailable", (error as Error).message);
    }
  });

  app.post("/api/clusters", async (request, reply) => {
    const input = parse(CreateClusterInput, request.body, reply);
    if (!input) return reply;
    const names = input.members.map((member) => member.name.toLowerCase());
    if (new Set(names).size !== names.length)
      return fail(reply, 400, "invalid_request", "Give each expert a different name.");
    try {
      return reply.code(201).send(await discussions.createCluster(input));
    } catch (error) {
      return fail(
        reply,
        400,
        (error as { code?: string }).code ?? "invalid_request",
        (error as Error).message,
      );
    }
  });

  app.post<{ Params: { id: string } }>("/api/threads/:id/discussion/roles", async (request, reply) => {
    const thread = groupThread(request.params.id, reply);
    if (!thread) return reply;
    const input = parse(SuggestRolesInput, request.body, reply);
    if (!input) return reply;
    try {
      const roles = await discussions.suggestRoles(
        discussions.members(thread),
        input.topic,
        input.goal,
        new AbortController().signal,
      );
      return { roles };
    } catch (error) {
      return fail(reply, 503, (error as { code?: string }).code ?? "unavailable", (error as Error).message);
    }
  });
}
