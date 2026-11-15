import {
  groupByLane,
  toolAllowed,
  type Bot,
  type MessagePart,
  type Message,
  type MessageStatus,
  type ToolInfo,
} from "@mrog/shared";

type ToolPart = Extract<MessagePart, { type: "tool" }>;

/** The two tools a lane may use. */
export const LANE_TOOLS = ["web_search", "fetch_url"] as const;

export type LaneStatus = "waiting" | "searching" | "writing" | "done" | "failed" | "stopped" | "no_answer";

export const LANE_STATUS_LABEL: Record<LaneStatus, string> = {
  waiting: "Starting",
  searching: "Searching",
  writing: "Writing",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  no_answer: "No answer",
};

export interface LaneSource {
  /** The page's host, without a leading "www.". */
  host: string;
  url: string;
}

export interface LaneCard {
  /** 1 to 3. */
  index: number;
  /** The role from the lane's heading; "Bot 2" until the heading has been written. */
  name: string;
  /** The heading has been written, so `name` is the model's own. */
  named: boolean;
  /** The role's focus: the line under its heading. Empty until written. */
  focus: string;
  /** The server has marked this lane finished (its heading part has `laneDone`), whatever the other lanes do. */
  finished: boolean;
  status: LaneStatus;
  /** Tool calls so far (every call counts as a step, whatever its outcome). */
  stepsUsed: number;
  stepsMax: number;
  /** "step 3 of 6", or that no tool has been used yet. */
  stepsText: string;
  tools: ToolPart[];
  sources: LaneSource[];
  /** The lane's answer: its text without the heading. */
  answer: string;
  hasAnswer: boolean;
  /** The lane's own error, shown inside its card only. */
  error: string | null;
  /** The reply ran with tools: the card shows tool rows, a step counter and sources. */
  withTools: boolean;
}

/** `## 1. Financial planner`, `### Role: Lawyer`, `## Lawyer`: the role name, or null when this isn't a heading. */
const HEADING =
  /^[ \t]{0,3}#{1,6}[ \t]*(?:(?:agent|bot|role)[ \t]*)?(?:[1-3][ \t]*[.:)\-–—][ \t]*)?(.*?)[ \t]*#*[ \t]*$/i;

function roleName(raw: string): string {
  return raw
    .replace(/\*\*/g, "")
    .trim()
    .replace(/^<(.*)>$/, "$1")
    .replace(/^["“'`]+|["”'`]+$/g, "")
    .trim();
}

/** A text split into its first heading (the role) and everything after it. No heading: the text is all answer. */
export function splitHeading(text: string): { name: string; named: boolean; rest: string } {
  const trimmed = text.replace(/^\s+/, "");
  const lineEnd = trimmed.indexOf("\n");
  const first = lineEnd === -1 ? trimmed : trimmed.slice(0, lineEnd);
  if (!/^[ \t]{0,3}#/.test(first)) return { name: "", named: false, rest: text.trim() };
  const match = HEADING.exec(first);
  const name = roleName(match?.[1] ?? "");
  // A heading still being typed ("##" or "## Fin") has no newline after it yet: the name is whatever there is so far.
  return { name, named: name !== "", rest: lineEnd === -1 ? "" : trimmed.slice(lineEnd + 1).trim() };
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]}]+/gi;

/** A link as a source: http(s) only, no fragment, no trailing punctuation. Null for anything else. */
function asSource(raw: string): LaneSource | null {
  try {
    const url = new URL(raw.replace(/[.,;:!?]+$/, ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return { host: url.hostname.replace(/^www\./, ""), url: url.toString() };
  } catch {
    return null;
  }
}

/**
 * The pages one lane looked at or found: the `url` its tool calls were given and the links in what they returned.
 * Only the parts passed in are read, so one lane can never list another lane's sources. Each page once, in the order
 * it first appeared.
 */
export function laneSources(parts: readonly MessagePart[]): LaneSource[] {
  const seen = new Set<string>();
  const sources: LaneSource[] = [];
  const add = (raw: unknown) => {
    const source = typeof raw === "string" ? asSource(raw.trim()) : null;
    if (!source) return;
    // The same page with or without "www." and a closing slash is one source.
    const url = new URL(source.url);
    const key = `${source.host}${url.pathname.replace(/\/$/, "")}${url.search}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(source);
  };
  for (const part of parts) {
    if (part.type !== "tool") continue;
    add(part.args.url);
    for (const link of part.result?.match(URL_IN_TEXT) ?? []) add(link);
  }
  return sources;
}

/** "step 3 of 6", or that nothing has been used. */
export const stepsText = (used: number, max: number): string =>
  used <= 0 ? `No steps yet (up to ${max})` : `step ${used} of ${max}`;

const isLiveTool = (part: ToolPart) => part.status === "running" || part.status === "pending_approval";

/**
 * What one lane's card shows, from that lane's parts (in the order they were written) and how the message stands.
 * Works on a lane that has only just begun: no heading, no tools and no text is a lane that is starting.
 */
export function laneCardState(
  parts: readonly MessagePart[],
  index: number,
  stepsMax: number,
  messageStatus: MessageStatus,
  /** False for a reply whose roles ran as separate requests without tools (on a cloud model). */
  withTools = true,
): LaneCard {
  // Without tools a lane has no tool parts; any that turned up anyway are not drawn or counted.
  const tools = withTools ? parts.filter((part): part is ToolPart => part.type === "tool") : [];
  const error = parts.find((part) => part.type === "error");
  const texts = parts.filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text");

  const first = texts[0];
  const heading = first ? splitHeading(first.text) : { name: "", named: false, rest: "" };
  // The heading part is `## n. Role`, then the role's focus on the next line. Only a lane that has a heading has a
  // focus; anything after the focus line is answer, so no text is ever lost.
  const [focusLine = "", ...afterFocus] = heading.named ? heading.rest.split("\n") : [];
  const focus = focusLine.trim();
  const opening = heading.named ? afterFocus.join("\n").trim() : heading.rest;
  const answer = [opening, ...texts.slice(1).map((part) => part.text.trim())].filter(Boolean).join("\n\n");
  const hasAnswer = answer !== "";
  const live = messageStatus === "streaming";
  const finished = first?.laneDone === true;

  let status: LaneStatus;
  if (error) status = "failed";
  // The server says this role has ended: show its outcome now, while the other lanes carry on.
  else if (finished) status = hasAnswer ? "done" : messageStatus === "stopped" ? "stopped" : "no_answer";
  else if (live) {
    if (tools.some(isLiveTool)) status = "searching";
    else if (hasAnswer) status = "writing";
    // Between steps, or about to start: the model is working on the next one.
    else status = tools.length > 0 ? "searching" : "waiting";
  } else if (hasAnswer) status = "done";
  else status = messageStatus === "stopped" ? "stopped" : "failed";

  return {
    index,
    name: heading.named ? heading.name : `Bot ${index}`,
    named: heading.named,
    focus,
    finished,
    status,
    stepsUsed: tools.length,
    stepsMax,
    stepsText: stepsText(tools.length, stepsMax),
    tools,
    sources: laneSources(tools),
    answer,
    hasAnswer,
    error: error?.type === "error" ? error.message : null,
    withTools,
  };
}

export interface LaneLayout {
  /** Cards in lane order. A lane with no parts yet is `null` while the reply is streaming (a placeholder). */
  cards: (LaneCard | null)[];
  /** Parts that belong to no lane: a note above the cards, or anything else the model wrote. */
  shared: MessagePart[];
}

/**
 * The cards of a Parallel Bots reply with tools. While it streams, every lane that hasn't started shows as a
 * placeholder, so the three-card layout is steady; once it has ended only lanes that wrote something are shown.
 * Lanes are read from the flat list of parts whatever order they were written in: they stream at the same time.
 */
export function laneLayout(
  parts: readonly MessagePart[],
  stepsMax: number,
  messageStatus: MessageStatus,
  withTools = true,
): LaneLayout {
  const { lanes, shared } = groupByLane(parts);
  const live = messageStatus === "streaming";
  const cards = lanes
    .map((laneParts, at) =>
      laneParts.length > 0 ? laneCardState(laneParts, at + 1, stepsMax, messageStatus, withTools) : null,
    )
    .filter((card) => card !== null || live);
  return { cards, shared };
}

/** The unlaned parts above the cards: notes ("Note: …") and other text as notices; tool rows and errors stay as they are. */
export function splitShared(shared: readonly MessagePart[]): { notices: string[]; rest: MessagePart[] } {
  const notices: string[] = [];
  const rest: MessagePart[] = [];
  for (const part of shared) {
    if (part.type === "text" || part.type === "reasoning") {
      if (part.type === "text" && part.text.trim()) notices.push(part.text.trim());
    } else rest.push(part);
  }
  return { notices, rest };
}

// ---- the Allow tools switch -------------------------------------------------------------------------------------

export interface ToolsChoice {
  ok: boolean;
  /** Why it is off, in plain words; null when it can be used. */
  reason: string | null;
}

/**
 * Whether Parallel Bots may run with tools for this bot: not a Visual Bot (it browses by looking at the screen), and at
 * least one of web_search and fetch_url allowed. `tools` is the Details panel's list when it has loaded; it knows
 * about tools held off by an app or the computer, which the bot's own lists don't.
 */
export function canAllowTools(bot: Pick<Bot, "visual" | "tools">, tools?: readonly ToolInfo[]): ToolsChoice {
  if (bot.visual)
    return {
      ok: false,
      reason:
        "A Visual Bot browses by looking at the screen, so its roles can't search the web at the same time.",
    };
  const usable = LANE_TOOLS.filter((name) => {
    const info = tools?.find((tool) => tool.name === name);
    return info ? info.enabled && info.available : toolAllowed(bot.tools, name);
  });
  return usable.length > 0
    ? { ok: true, reason: null }
    : {
        ok: false,
        reason: "This bot has web search and page fetching turned off. Turn one on under Tools in Details.",
      };
}

export const TOOLS_SWITCH_LABEL = "Allow tools";

export const TOOLS_TIP =
  "With tools, each of the three roles searches the web on its own, at the same time, and never sees the others' searches. Slower than one request.";

/** The switch's tooltip and accessible description: what it does, or why it can't be used. */
export function toolsSwitchTip(choice: ToolsChoice, on: boolean): string {
  if (!choice.ok) return `${TOOLS_SWITCH_LABEL} is off: ${choice.reason}`;
  return on ? `${TOOLS_SWITCH_LABEL} is on. ${TOOLS_TIP}` : `${TOOLS_SWITCH_LABEL}: ${TOOLS_TIP}`;
}

/** Whether a message is sent with tools: Parallel Bots is on, the switch is on, and the bot may use tools. */
export const sendsParallelTools = (parallel: boolean, allowTools: boolean, choice: ToolsChoice): boolean =>
  parallel && allowTools && choice.ok;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A tool row's label in a lane: `web_search: heat pump grants`, `fetch_url: example.com`. */
export function laneToolTitle(part: ToolPart): string {
  if (part.name === "fetch_url" && typeof part.args.url === "string") {
    const source = asSource(part.args.url.trim());
    return `fetch_url: ${source ? source.host : clip(part.args.url, 40)}`;
  }
  const first = Object.values(part.args).find((value) => typeof value === "string") as string | undefined;
  return first ? `${part.name}: ${clip(first, 60)}` : part.name;
}

/** A whole number from `min` to `max` typed into a field, or null when it isn't one. */
export function parseBounded(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

// ---- which view a Parallel Bots reply gets -------------------------------------------------------------------------

/** Whether any part of a reply belongs to a lane: its roles ran as separate conversations. */
export const hasLanes = (parts: readonly MessagePart[]): boolean =>
  groupByLane(parts).lanes.some((lane) => lane.length > 0);

export type ParallelView = "lanes" | "sections" | "plain";

/**
 * How a bot's reply is drawn. Lane cards when its roles ran separately: with tools, or as three requests at once on a
 * cloud model (lane-tagged parts). Sections when it is the older single Parallel Bots reply (a local model without
 * tools). Otherwise as an ordinary reply.
 */
export function parallelView(message: Pick<Message, "parallel" | "parallelTools" | "parts">): ParallelView {
  if (message.parallelTools || hasLanes(message.parts)) return "lanes";
  return message.parallel ? "sections" : "plain";
}

/** The label above your message: "Parallel Bots", or "Parallel Bots with tools". */
export const parallelLabel = (message: Pick<Message, "parallelTools">): string =>
  message.parallelTools ? "Parallel Bots with tools" : "Parallel Bots";

/** The Parallel switch's tooltip. True whether the roles answer in one request or in three. */
export const parallelSwitchTip = (on: boolean): string =>
  on
    ? "Parallel Bots is on: each message gets three answers from three roles. Click to turn it off"
    : "Parallel Bots: ask once and get three answers from three roles";

export const SEPARATE_ON_CLOUD_LABEL = "Parallel Bots on cloud models: ask each role separately";
export const SEPARATE_ON_CLOUD_HINT =
  "Faster, and the three roles can't echo each other; uses about three times the input tokens. Off: one request with three sections, like local models.";
