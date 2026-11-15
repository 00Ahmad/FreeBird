import {
  groupByLane,
  PARALLEL_SECTIONS,
  type LoadedModel,
  type Message,
  type MessagePart,
} from "@mrog/shared";

import { normalizeUrl, URL_PATTERN } from "./discussion";

/**
 * Parallel Bots with tools: the three roles run as their own conversations, side by side. This module holds the pieces
 * that don't need the turn machinery: the request that picks the roles, the note each lane gets, how a lane's parts
 * are read back, and the memory warning.
 */

/** What a lane may use: search and open pages, nothing else. */
export const LANE_TOOLS = ["web_search", "fetch_url"] as const;
/** How far apart the lanes start, so three searches don't hit a search engine in the same instant. */
export const LANE_STAGGER_MS = 250;
/** The most of a tool result (a fetched page) a lane's model reads: three lanes re-send their results every step. */
export const LANE_RESULT_CHARS = 4000;
/** A model counts as fully on the GPU when at least this share of it is there. */
export const GPU_TOLERANCE = 0.98;

export interface LaneRole {
  role: string;
  focus: string;
}

/** Used when the model's roles can't be read (or give fewer than three). */
export const FALLBACK_ROLES: LaneRole[] = [
  { role: "Analyst", focus: "the facts and how things really work" },
  { role: "Critic", focus: "the risks, the downsides and what could go wrong" },
  { role: "Practical advisor", focus: "what to actually do, step by step" },
];

/** The one short request that picks the roles (no tools). */
export function rolesRequest(question: string): { system: string; user: string } {
  return {
    system: [
      "You pick three roles to answer a message, working side by side. Each role is a different viewpoint or kind of expertise, covering a different part of what was asked.",
      "Reply with exactly three lines and nothing else, in this form:",
      "1. <role name in two to four words> | <one line: what this role should look into>",
      "2. <role name> | <focus>",
      "3. <role name> | <focus>",
      'Example for "Should I rent or buy a flat?":\n1. Financial planner | the total cost of renting against buying over ten years\n2. Local estate agent | how this city\'s market behaves right now\n3. Lifestyle coach | what living there for years would be like',
    ].join("\n\n"),
    user: question.trim().slice(0, 4000),
  };
}

const clean = (text: string) =>
  text
    .replace(/\*\*/g, "")
    .trim()
    .replace(/^<(.*)>$/, "$1")
    .replace(/^["“'`]+|["”'`]+$/g, "")
    .replace(/[.:;,]+$/, "")
    .trim();

/** Splits "Role | focus", "Role: focus" or "Role - focus". */
function splitLine(line: string): LaneRole | null {
  const text = line
    .replace(/^\s*(?:[-*•]\s+|#{1,6}\s*)?/, "")
    .replace(/^(?:(?:role|agent|bot)\s*)?\d+\s*[.):\-–—]\s*/i, "")
    .trim();
  for (const separator of ["|", ":", " – ", " — ", " - "]) {
    const at = text.indexOf(separator);
    if (at < 1) continue;
    const role = clean(text.slice(0, at));
    const focus = clean(text.slice(at + separator.length));
    if (role && role.length <= 60 && focus) return { role, focus };
  }
  return null;
}

/**
 * The three roles from the model's reply, however it wrote them (numbered lines, bullets, a JSON list). Anything
 * missing is filled in from the fallback roles, so a lane always has a role.
 */
export function parseRoles(reply: string): LaneRole[] {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/g, "");
  const roles: LaneRole[] = [];
  const add = (role: LaneRole | null) => {
    if (
      role &&
      roles.length < PARALLEL_SECTIONS &&
      !roles.some((r) => r.role.toLowerCase() === role.role.toLowerCase())
    )
      roles.push(role);
  };
  const json = /\[[\s\S]*\]/.exec(text)?.[0];
  if (json) {
    try {
      const list: unknown = JSON.parse(json);
      if (Array.isArray(list))
        for (const item of list) {
          const entry = item as { role?: unknown; name?: unknown; focus?: unknown };
          const role = typeof entry.role === "string" ? entry.role : entry.name;
          if (
            typeof role === "string" &&
            typeof entry.focus === "string" &&
            clean(role) &&
            clean(entry.focus)
          )
            add({ role: clean(role).slice(0, 60), focus: clean(entry.focus) });
        }
    } catch {
      // not JSON: the lines below
    }
  }
  if (roles.length < PARALLEL_SECTIONS) for (const line of text.split("\n")) add(splitLine(line));
  for (const fallback of FALLBACK_ROLES) add(fallback);
  return roles;
}

/** The note added to a lane's newest user message: who it is, what to look into, what it may use and how long. */
export function laneNote(options: {
  index: number;
  role: string;
  focus: string;
  tools: string[];
  steps: number;
}): string {
  const { index, role, focus, tools, steps } = options;
  return [
    `(Parallel Bots, role ${index} of ${PARALLEL_SECTIONS}. You are the ${role}. Your focus: ${focus}.`,
    "Two other roles are answering the same message separately. You can't see them, so don't mention them or repeat what they might say.",
    tools.length > 0
      ? `Use ${tools.join(" and ")} only when you need facts, at most ${steps} steps in all, and then write your answer. Take facts only from results you got, and give the address next to each fact.`
      : "You have no tools: answer from what you know.",
    "Write your complete answer from this role's point of view, as long as the message needs. Don't write a heading or the role name: the app adds them.)",
  ].join(" ");
}

/**
 * The note for a role that runs without tools (Parallel Bots on a cloud model, each role its own request): who it is,
 * what to look into, and that it can't see the other two. Nothing about tools or steps.
 */
export function plainLaneNote(options: { index: number; role: string; focus: string }): string {
  const { index, role, focus } = options;
  return [
    `(Parallel Bots, role ${index} of ${PARALLEL_SECTIONS}. You are the ${role}. Your focus: ${focus}.`,
    "Two other roles are answering the same message separately. You can't see them, so don't mention them or repeat what they might say.",
    "Write your complete answer from this role's point of view, as long as the message needs. Don't write a heading or the role name: the app adds them.)",
  ].join(" ");
}

/** The first part of a lane: its heading (numbered role name) and, on the next line, its focus. */
export const laneHeader = (index: number, role: string, focus: string) => `## ${index}. ${role}\n${focus}`;

/** Reads a lane's heading part back; null when the text isn't one. */
export function readLaneHeader(text: string): { index: number; role: string; focus: string } | null {
  const match = /^## ([1-3])\. ([^\n]*)(?:\n([\s\S]*))?$/.exec(text);
  return match ? { index: Number(match[1]), role: match[2]!, focus: match[3] ?? "" } : null;
}

/** What one lane wrote as its answer (its text, not the heading), and its role. */
function laneOf(parts: MessagePart[], index: number): { role: string; answer: string } {
  const header = parts.find((part) => part.type === "text" && readLaneHeader(part.text));
  const role = header?.type === "text" ? (readLaneHeader(header.text)?.role ?? "") : "";
  const answer = parts
    .filter((part) => part.type === "text" && part !== header)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
  return { role: role || `Role ${index}`, answer };
}

/**
 * A Parallel Bots reply with tools as it goes back to the model in later turns: each lane's final answer under its
 * role, as "## Role" sections. Never the searches, the results or the reasoning. A lane that wrote nothing is left out.
 */
export function laneAnswersText(parts: MessagePart[]): string {
  const { lanes } = groupByLane(parts);
  return lanes
    .map((lane, i) => ({ ...laneOf(lane, i + 1) }))
    .filter((lane) => lane.answer)
    .map((lane) => `## ${lane.role}\n${lane.answer}`)
    .join("\n\n");
}

/** Whether a reply was written by lanes (each role its own conversation, with tools or without). */
export const hasLanes = (message: Pick<Message, "parts">) =>
  message.parts.some((part) => "lane" in part && part.lane !== undefined);

/** Messages as the model reads them: a reply whose roles each ran on their own becomes just their answers. */
export function forHistory(messages: Message[]): Message[] {
  return messages.map((message) =>
    message.role === "bot" && hasLanes(message)
      ? { ...message, parts: [{ type: "text", text: laneAnswersText(message.parts) }] }
      : message,
  );
}

/** The addresses one lane has really seen: in its own searches and pages, and in what the user wrote. */
export function laneKnownLinks(laneParts: MessagePart[], userText: string): Set<string> {
  const known = new Set<string>();
  const take = (text: string) => {
    for (const url of text.match(URL_PATTERN) ?? []) known.add(normalizeUrl(url));
  };
  take(userText);
  for (const part of laneParts)
    if (part.type === "tool") take(`${JSON.stringify(part.args)} ${part.result ?? ""}`);
  return known;
}

/**
 * A line for the top of the reply when three requests at once may be too much for the local model: Ollama reports it
 * is not fully on the GPU (part of it runs on the CPU, so three requests at once will crawl). Null when it is (a large
 * context that fits is fine), with a single lane, or when nothing is known about the model (a cloud one).
 */
export function memoryWarning(options: {
  lanes: number;
  loaded: LoadedModel | undefined;
  numCtx: number;
}): string | null {
  const { lanes, loaded, numCtx } = options;
  if (lanes < 2 || !loaded || loaded.sizeBytes <= 0) return null;
  // A little tolerance: Ollama's two sizes can differ by a rounding.
  if (loaded.vramBytes >= loaded.sizeBytes * GPU_TOLERANCE) return null;
  const onGpu = Math.round((100 * loaded.vramBytes) / loaded.sizeBytes);
  return `Heads up: ${lanes === PARALLEL_SECTIONS ? "three roles" : `${lanes} roles`} write at the same time, and the model isn't fully on the GPU (${onGpu}% of it is, with a context of ${numCtx.toLocaleString("en-US")} tokens). If it is slow or runs out of memory, use a smaller context in Settings → Local model, and set Ollama's OLLAMA_NUM_PARALLEL to ${lanes}.`;
}

/** A tool result as the lane's model reads it: long pages are cut, since every step re-sends it. */
export function clipForLane(text: string, max = LANE_RESULT_CHARS): string {
  return text.length > max
    ? `${text.slice(0, max).trimEnd()}\n…(cut: ${text.length - max} more characters)`
    : text;
}
