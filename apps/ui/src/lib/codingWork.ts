import { SLOW_CARD_SECONDS, type CodingCard, type CodingProject, type Message } from "@mrog/shared";

import { roleLabel } from "./coding";

type Running = Pick<CodingProject, "active">;

/** Seconds, never negative or odd: a missing or broken number counts as none. */
const clean = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** When the running turn started, in milliseconds; null when there is none or the time can't be read. */
function runningSince(project: Running): number | null {
  const since = project.active?.since;
  if (!since) return null;
  const at = Date.parse(since);
  return Number.isNaN(at) ? null : at;
}

/** Seconds the turn that is running has been going. A start time in the future (clocks differ) counts as 0. */
function runningSeconds(project: Running, now: number): number {
  const at = runningSince(project);
  return at === null ? 0 : Math.max(0, (now - at) / 1000);
}

/**
 * Seconds spent on a card: its finished turns, plus the turn running on it now. Cards made before this was tracked
 * have no `work` and count as 0.
 */
export function cardElapsedSeconds(
  card: Pick<CodingCard, "id" | "work">,
  project: Running,
  now: number,
): number {
  const base = clean(card.work?.seconds);
  return project.active?.cardId === card.id ? base + runningSeconds(project, now) : base;
}

/** The card has taken as long as the limit (10 minutes) or longer. */
export const isSlowCard = (card: Pick<CodingCard, "id" | "work">, project: Running, now: number): boolean =>
  cardElapsedSeconds(card, project, now) >= SLOW_CARD_SECONDS;

/** "45 s", "12 min", "1 h 05 min". Whole units, rounded down. */
export function formatDuration(seconds: number): string {
  const total = Math.floor(clean(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

const trimmed = (value: number) => String(Math.round(value * 10) / 10);

/** "950", "1.5k", "58k", "1.5M", "2.3B". */
export function formatTokens(count: number): string {
  const n = Math.floor(clean(count));
  if (n < 1000) return String(n);
  if (n < 10_000) return `${trimmed(n / 1000)}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${trimmed(n / 1_000_000)}M`;
  if (n < 999_500_000) return `${Math.round(n / 1_000_000)}M`;
  return `${trimmed(n / 1_000_000_000)}B`;
}

/** "12 min · 1.5M in · 58k out · 2 turns": what a card has cost so far. Null when there is nothing to say yet. */
export function cardWorkLine(
  card: Pick<CodingCard, "id" | "work">,
  project: Running,
  now: number,
): string | null {
  const seconds = cardElapsedSeconds(card, project, now);
  const work = card.work;
  const parts = [
    seconds >= 1 ? formatDuration(seconds) : null,
    clean(work?.inputTokens) > 0 ? `${formatTokens(work!.inputTokens)} in` : null,
    clean(work?.outputTokens) > 0 ? `${formatTokens(work!.outputTokens)} out` : null,
    clean(work?.turns) > 0 ? `${work!.turns} ${work!.turns === 1 ? "turn" : "turns"}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "Slow: 12 min". */
export const slowBadge = (seconds: number): string => `Slow: ${formatDuration(seconds)}`;

/** The tooltip on the slow badge. */
export const SLOW_TOOLTIP = `This card has taken more than ${SLOW_CARD_SECONDS / 60} minutes. A smaller or faster model for this role may help.`;

export interface Totals {
  seconds: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

/** Time and tokens summed over every card, counting the turn running now. */
export function projectTotals(project: Pick<CodingProject, "cards" | "active">, now: number): Totals {
  const totals: Totals = { seconds: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
  for (const card of project.cards) {
    totals.seconds += cardElapsedSeconds(card, project, now);
    totals.inputTokens += clean(card.work?.inputTokens);
    totals.outputTokens += clean(card.work?.outputTokens);
    totals.turns += clean(card.work?.turns);
  }
  return totals;
}

/** "Total: 1 h 32 min · 4.6M tokens", or null before any work. */
export function totalsLine(totals: Totals): string | null {
  const tokens = totals.inputTokens + totals.outputTokens;
  const parts = [
    totals.seconds >= 1 ? formatDuration(totals.seconds) : null,
    tokens > 0 ? `${formatTokens(tokens)} tokens` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `Total: ${parts.join(" · ")}` : null;
}

/**
 * How long the role at work has been on its turn: on its card (all its turns so far) or, with no card (the Planner),
 * since the turn started. Null when nothing is running or no start time is known.
 */
export function activeElapsed(project: Pick<CodingProject, "cards" | "active">, now: number): number | null {
  const active = project.active;
  if (!active || runningSince(project) === null) return null;
  const card = project.cards.find((candidate) => candidate.id === active.cardId);
  return card ? cardElapsedSeconds(card, project, now) : runningSeconds(project, now);
}

interface Activity {
  botId: string | null;
  activity: string;
}

/**
 * Whether the role at work is waiting for the user (a command to approve, most often) rather than working: a chat of
 * the team (`threads`: the Coding Bot's own and its conversations with its roles) or the role bot itself is marked
 * "waiting for you", or the latest tool call in the given messages (the Coding Bot's chat, which shows its roles'
 * approval cards) waits for approval.
 */
export function roleWaiting(
  project: Pick<CodingProject, "active" | "roles">,
  activity: Readonly<Record<string, Activity>>,
  threads: ReadonlySet<string>,
  messages: readonly Pick<Message, "parts">[] = [],
): boolean {
  const active = project.active;
  if (!active) return false;
  const roleBot = project.roles[active.role].botId;
  const marked = Object.entries(activity).some(
    ([threadId, entry]) =>
      entry.activity === "waiting_user" && (entry.botId === roleBot || threads.has(threadId)),
  );
  if (marked) return true;
  for (const message of messages.toReversed()) {
    const tool = message.parts.findLast((part) => part.type === "tool");
    if (tool) return tool.type === "tool" && tool.status === "pending_approval";
  }
  return false;
}

/** The banner's line while the role at work waits for the user: the clock runs on, but the model isn't slow. */
export function waitingHint(project: Pick<CodingProject, "active">): string | null {
  const active = project.active;
  if (!active) return null;
  return `The ${roleLabel(active.role)} is waiting for your approval. The time on the card keeps counting meanwhile; the model isn't slow.`;
}

/**
 * One plain line for the status banner while the card being worked on is slow. Not while the role waits for the user
 * (`waiting`): that time is the user's, and a faster model wouldn't help.
 */
export function slowHint(
  project: Pick<CodingProject, "cards" | "active">,
  now: number,
  waiting = false,
): string | null {
  const active = project.active;
  const card = active ? project.cards.find((candidate) => candidate.id === active.cardId) : undefined;
  if (!active || !card || waiting || !isSlowCard(card, project, now)) return null;
  const seconds = cardElapsedSeconds(card, project, now);
  return `The ${roleLabel(active.role)} has spent ${formatDuration(seconds)} on this card. A smaller or faster model for this role may help; you can change it under Models.`;
}
