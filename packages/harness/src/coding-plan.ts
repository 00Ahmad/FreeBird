import { statSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_PLAN_EDGES,
  MAX_PLAN_FILES,
  type CardWork,
  type CodingCard,
  type CodingEdge,
  type CodingNode,
  type CodingProject,
} from "@mrog/shared";

/** The longest purpose or connection description a plan may carry: a plan nobody can read is not a plan. */
const MAX_TEXT = 2000;
/** Characters a file name can't have on Windows (the strictest system), plus control characters. */
const BAD_NAME = /[<>:"|?*]/;
const hasControlCharacter = (text: string) => [...text].some((char) => char.charCodeAt(0) < 32);

export type PlanResult =
  { ok: true; nodes: CodingNode[]; edges: CodingEdge[] } | { ok: false; errors: string[] };

/** A path the way the plan keeps it: forward slashes, no "./" in front, no doubled slashes. */
export function normalizePlanPath(path: string): string {
  return path
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^(?:\.\/)+/, "");
}

const asList = (value: unknown): unknown[] | null => {
  let list = value;
  // Small models often send a list as a string of JSON.
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  return Array.isArray(list) ? list : null;
};

const asText = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const quote = (text: string) => `“${text.length > 80 ? `${text.slice(0, 80)}…` : text}”`;

/** The files of one connection: a list, or one string with names split by commas or lines. */
function filesOf(value: unknown): string[] | null {
  const list = asList(value);
  if (list) return list.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return value.split(/[\n,]+/).filter((name) => name.trim());
  return null;
}

/** What is wrong with a file path, or null. */
function pathProblem(path: string): string | null {
  if (!path) return "the path is empty";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
    return "paths are relative to the output folder; this one is absolute";
  if (path.split("/").includes("..")) return 'paths can\'t contain ".." (they stay inside the output folder)';
  if (path.endsWith("/")) return "that is a folder; list files only";
  if (BAD_NAME.test(path) || hasControlCharacter(path))
    return "it has characters a file name can't have (< > : \" | ? *)";
  return null;
}

/**
 * Checks a plan the planner sent (as a tool call or a JSON block) and turns it into nodes and edges with their ids.
 * Every problem found is listed, not only the first, so one retry can fix them all. Files are in the order given: the
 * planner's build order. Connections refer to files by path.
 */
export function validatePlan(raw: unknown): PlanResult {
  const errors: string[] = [];
  const plan =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!plan) return { ok: false, errors: ["The plan must be an object with nodes (the files) and edges."] };

  const rawNodes = asList(plan.nodes ?? plan.files);
  if (!rawNodes || rawNodes.length === 0)
    return {
      ok: false,
      errors: [
        'The plan has no files. "nodes" must be a list with one entry per file: {"path": "src/main.py", "purpose": "what the code in it does"}.',
      ],
    };
  if (rawNodes.length > MAX_PLAN_FILES)
    errors.push(
      `The plan has ${rawNodes.length} files; the limit is ${MAX_PLAN_FILES}. Merge small files or leave out what isn't needed.`,
    );

  const nodes: CodingNode[] = [];
  const seen = new Map<string, number>();
  rawNodes.slice(0, MAX_PLAN_FILES).forEach((entry, index) => {
    const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const path = normalizePlanPath(asText(item.path));
    const label = `nodes[${index}]${path ? ` ${quote(path)}` : ""}`;
    const problem = pathProblem(path);
    if (problem) return void errors.push(`${label}: ${problem}.`);
    const purpose = asText(item.purpose ?? item.description);
    if (!purpose) errors.push(`${label}: the purpose is empty. Say what the code in this file should do.`);
    else if (purpose.length > MAX_TEXT)
      errors.push(`${label}: the purpose is ${purpose.length} characters; keep it under ${MAX_TEXT}.`);
    const key = path.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined)
      return void errors.push(`${label}: listed twice (also nodes[${first}]). Each file appears once.`);
    seen.set(key, index);
    nodes.push({ id: `n${nodes.length + 1}`, path, purpose });
  });
  // "src" can't be a file when "src/app.py" needs it to be a folder.
  for (const node of nodes) {
    const inside = nodes.find((other) => other.path.toLowerCase().startsWith(`${node.path.toLowerCase()}/`));
    if (inside)
      errors.push(
        `${quote(node.path)} is listed as a file, but ${quote(inside.path)} needs it to be a folder.`,
      );
  }

  const rawEdges = plan.edges === undefined || plan.edges === null ? [] : asList(plan.edges);
  const edges: CodingEdge[] = [];
  if (!rawEdges) errors.push('"edges" must be a list (it can be empty).');
  else {
    if (rawEdges.length > MAX_PLAN_EDGES)
      errors.push(
        `The plan has ${rawEdges.length} connections; the limit is ${MAX_PLAN_EDGES}. Join connections that link the same files.`,
      );
    const byPath = new Map(nodes.map((node) => [node.path.toLowerCase(), node]));
    const known = nodes
      .slice(0, 12)
      .map((node) => node.path)
      .join(", ");
    const made = new Set<string>();
    rawEdges.slice(0, MAX_PLAN_EDGES).forEach((entry, index) => {
      const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const label = `edges[${index}]`;
      const listed = filesOf(item.files ?? item.nodes);
      if (!listed) return void errors.push(`${label}: "files" must be a list of the file paths it connects.`);
      const ids: string[] = [];
      for (const name of listed) {
        const node = byPath.get(normalizePlanPath(name).toLowerCase());
        if (!node) {
          errors.push(
            `${label}: ${quote(name)} isn't one of the plan's files. Files in the plan: ${known}${nodes.length > 12 ? ", …" : ""}.`,
          );
        } else if (!ids.includes(node.id)) ids.push(node.id);
      }
      const unknown = listed.some((name) => !byPath.has(normalizePlanPath(name).toLowerCase()));
      if (!unknown && ids.length < 2)
        errors.push(
          `${label}: a connection links at least 2 different files; this one has ${ids.length}. Name every file it links.`,
        );
      const description = asText(item.description ?? item.purpose);
      if (!description) errors.push(`${label}: the description is empty. Say what connects these files.`);
      else if (description.length > MAX_TEXT)
        errors.push(
          `${label}: the description is ${description.length} characters; keep it under ${MAX_TEXT}.`,
        );
      if (unknown || ids.length < 2 || !description || description.length > MAX_TEXT) return;
      // The same connection written twice is one connection.
      const signature = `${ids.toSorted().join("+")}|${description.toLowerCase()}`;
      if (made.has(signature)) return;
      made.add(signature);
      edges.push({ id: `e${edges.length + 1}`, files: ids, description });
    });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, nodes, edges };
}

/** Every `{…}` in the text that is a whole JSON object, outermost first (strings and nesting respected). */
function objectsIn(text: string): string[] {
  const found: string[] = [];
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (char === "\\") i += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        found.push(text.slice(start, i + 1));
        start = i;
        break;
      }
    }
  }
  return found;
}

/**
 * The plan in a reply that didn't use the tool: the last fenced ```json block (or any fenced block, or a bare object)
 * that parses to an object with files in it. Null when there is none.
 */
export function planFromReply(reply: string): unknown {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/g, "");
  const blocks = [...text.matchAll(/```(?:json|JSON)?[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const candidates = [...blocks.toReversed(), ...objectsIn(text).toReversed()];
  for (const candidate of candidates) {
    for (const body of [candidate, ...objectsIn(candidate)]) {
      try {
        const parsed: unknown = JSON.parse(body.trim());
        if (parsed && typeof parsed === "object" && ("nodes" in parsed || "files" in parsed)) return parsed;
      } catch {
        // not this one
      }
    }
  }
  return null;
}

/** A card's time and token counts before anyone has worked on it. */
export const zeroWork = (): CardWork => ({
  startedAt: null,
  seconds: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
});

/** The board for a fresh plan: a card per file, then a card per connection, all in Todo. */
export function cardsFor(nodes: CodingNode[], edges: CodingEdge[]): CodingCard[] {
  const path = new Map(nodes.map((node) => [node.id, node.path]));
  return [
    ...nodes.map((node): CodingCard => ({
      id: `card_${node.id}`,
      kind: "file",
      ref: node.id,
      title: node.path,
      column: "todo",
      comments: [],
      work: zeroWork(),
    })),
    ...edges.map((edge): CodingCard => {
      const title = edge.files.map((id) => path.get(id) ?? id).join(" ↔ ");
      return {
        id: `card_${edge.id}`,
        kind: "connector",
        ref: edge.id,
        title: title.length > 120 ? `${title.slice(0, 119)}…` : title,
        column: "todo",
        comments: [],
        work: zeroWork(),
      };
    }),
  ];
}

// ---- the board, as the loop reads it ----------------------------------------------------------------------

/** The file cards a connection links. */
export function linkedFileCards(project: CodingProject, edgeId: string): CodingCard[] {
  const edge = project.edges.find((candidate) => candidate.id === edgeId);
  return (edge?.files ?? []).flatMap((id) => project.cards.find((card) => card.ref === id) ?? []);
}

/** The connection cards that link a file. */
export function connectorsTouching(project: CodingProject, nodeId: string): CodingCard[] {
  const ids = new Set(project.edges.filter((edge) => edge.files.includes(nodeId)).map((edge) => edge.id));
  return project.cards.filter((card) => card.kind === "connector" && ids.has(card.ref));
}

/**
 * Whether a card can be worked on or reviewed now. A file always can. A connection only once every file it links
 * has been written (is in QA or Done): until then there is nothing to connect, or a file is about to change.
 */
export function filesReady(project: CodingProject, card: CodingCard): boolean {
  if (card.kind === "file") return true;
  return linkedFileCards(project, card.ref).every((file) => file.column === "qa" || file.column === "done");
}

/** The next card for the Developer: a Todo file in the planner's order, else a Todo connection whose files are ready. */
export function nextForDeveloper(project: CodingProject): CodingCard | null {
  return (
    project.cards.find((card) => card.kind === "file" && card.column === "todo") ??
    project.cards.find(
      (card) => card.kind === "connector" && card.column === "todo" && filesReady(project, card),
    ) ??
    null
  );
}

/** The cards in the QA column that QA may review now, in board order. */
export function reviewable(project: CodingProject): CodingCard[] {
  return project.cards.filter((card) => card.column === "qa" && filesReady(project, card));
}

// ---- importing a plan ----------------------------------------------------------------------------------------

/** The `format` value of a plan file written by the app's Export. */
export const PLAN_FILE_FORMAT = "freebird-coding-plan";

export interface ReadPlan {
  /** Handed to `validatePlan`. */
  plan: unknown;
  /** What the file says the project is for, if it says. */
  brief: string | null;
}

/**
 * The plan in what the user handed in: a plan file (JSON text or the parsed object), a bare plan, or a chat reply with
 * the plan in it. A string that holds a plan is read the way the planner's own reply is. Null when there is no plan to
 * be found; a plan file of a version this app doesn't know is an error with a message.
 */
export function readPlanInput(input: unknown): ReadPlan | { error: string } | null {
  let value: unknown = input;
  if (typeof value === "string") {
    const text = value.trim();
    try {
      value = JSON.parse(text);
    } catch {
      value = planFromReply(text);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (object.format === PLAN_FILE_FORMAT && object.version !== 1)
    return {
      error: `This plan file is version ${String(object.version)}, which this app can't read (it reads version 1).`,
    };
  if (!("nodes" in object || "files" in object)) return null;
  const brief = typeof object.brief === "string" && object.brief.trim() ? object.brief.trim() : null;
  return { plan: object, brief };
}

/**
 * Whether a file card's file is already in the output folder from this project: never sent back by QA, not empty, and
 * written since the project began (an older file in the folder is not the team's work). Then there is nothing for the
 * Developer to do but hand it on. Never true for a connection.
 */
export function alreadyWritten(project: CodingProject, card: CodingCard): boolean {
  if (card.kind !== "file" || card.comments.length > 0) return false;
  const node = project.nodes.find((candidate) => candidate.id === card.ref);
  if (!node) return false;
  try {
    const info = statSync(join(project.outputFolder, node.path));
    return info.isFile() && info.size > 0 && info.mtimeMs >= Date.parse(project.startedAt);
  } catch {
    return false;
  }
}
