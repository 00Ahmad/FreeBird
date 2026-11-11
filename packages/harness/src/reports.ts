import { parseModelRef, type ModelRef } from "@mrog/shared";

import type { Services } from "./services";

/**
 * Checks on the reports that end a discussion or a race: which of the sections asked for are missing or left empty,
 * and putting a follow-up that fills them back into the report.
 */

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The headings in a section template: its `###` lines (`##` when it has none), without notes in parentheses. */
export function templateHeadings(template: string): string[] {
  const lines = template.split("\n");
  const level = lines.some((line) => line.startsWith("### ")) ? "### " : "## ";
  return lines.filter((line) => line.startsWith(level)).map((line) => line.slice(level.length).trim());
}

/**
 * The start of a line that is `heading`, any case: a `#` heading of any level (which may add words after a colon or
 * dash: "## Final result: a 30-day plan"), the name alone on its line (bold allowed), or a bold label with the
 * section's text after it on the same line ("**Why:** Bilal was clearest"). The match ends where the text begins.
 */
const headingLine = (heading: string, flags = "i") => {
  const words = escapeRegExp(heading);
  const name = `(?:\\*\\*)?[ \\t]*${words}[ \\t]*(?:\\*\\*)?`;
  const end = "[ \\t]*\\r?$";
  return new RegExp(
    [
      `^[ \\t]*#{1,6}[ \\t]+${name}(?:[ \\t]*[:—–-][^\\n]*)?${end}`,
      `^[ \\t]*${name}[ \\t]*:?[ \\t]*(?:\\*\\*)?${end}`,
      `^[ \\t]*\\*\\*[ \\t]*${words}[ \\t]*:?[ \\t]*\\*\\*[ \\t]*:?`,
    ].join("|"),
    flags,
  );
};

/** Where `heading` is in `text` as a heading line, or null. */
function findHeading(text: string, heading: string): { start: number; end: number } | null {
  const match = headingLine(heading, "im").exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/**
 * The text under a heading, up to the next of the report's own headings. Other headings (a plan's "Week 1", a line in
 * bold) belong to the section: a final result often has headings of its own.
 */
function bodyAfter(text: string, from: number, headings: string[]): { body: string; end: number } {
  const rest = text.slice(from);
  const lines = rest.split("\n");
  const next = headings.map((heading) => headingLine(heading));
  let length = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0 && next.some((pattern) => pattern.test(lines[i]!))) break;
    length += lines[i]!.length + 1;
  }
  return { body: rest.slice(0, length), end: from + Math.min(length, rest.length) };
}

/** A body with nothing in it: blank, or only a placeholder like "<…>" or "(…)". */
const isEmpty = (body: string) => {
  const clean = body
    .replace(/<[^>\n]*>/g, "")
    .replace(/[\s*_\-|:().…]/g, "")
    .trim();
  return clean.length === 0;
};

/** The headings from `headings` that `text` lacks or leaves empty. */
export function sectionGaps(text: string, headings: string[]): string[] {
  return headings.filter((heading) => {
    const at = findHeading(text, heading);
    return !at || isEmpty(bodyAfter(text, at.end, headings).body);
  });
}

/** The text of one section (up to the next of `headings`), or null when `text` lacks it. */
export function sectionText(text: string, heading: string, headings: string[]): string | null {
  const at = findHeading(text, heading);
  return at ? bodyAfter(text, at.end, headings).body.trim() : null;
}

/** Of `headings`, the one that comes last in `text` (where a cut-off answer stopped), or null. */
export function lastSection(text: string, headings: string[]): string | null {
  let best: { heading: string; at: number } | null = null;
  for (const heading of headings) {
    const at = findHeading(text, heading)?.start;
    if (at !== undefined && (!best || at > best.at)) best = { heading, at };
  }
  return best?.heading ?? null;
}

/**
 * Puts the sections in `addition` into `text`: a section `text` already has but left empty gets the new body in
 * place; one it lacks is added at the end. Only the headings in `wanted` are taken from the addition. `headings`:
 * all the report's sections, where each section's text ends.
 */
export function mergeSections(
  text: string,
  addition: string,
  wanted: string[],
  headings: string[] = wanted,
  level = "###",
): string {
  const all = [...new Set([...headings, ...wanted])];
  let merged = text.trimEnd();
  for (const heading of wanted) {
    const given = findHeading(addition, heading);
    if (!given) continue;
    const body = bodyAfter(addition, given.end, all).body.trim();
    if (isEmpty(body)) continue;
    const at = findHeading(merged, heading);
    if (at) {
      const old = bodyAfter(merged, at.end, all);
      merged = `${merged.slice(0, at.end)}\n${body}\n${old.end < merged.length ? "\n" : ""}${merged.slice(old.end).replace(/^\n+/, "")}`;
    } else {
      merged = `${merged}\n\n${level} ${heading}\n${body}`;
    }
  }
  return merged.trimEnd();
}

/**
 * Splits a budget of characters over several texts so each keeps its start: short ones whole, the rest cut evenly
 * (rather than dropping the oldest, as a cut from the end would).
 */
export function fitTexts(texts: string[], budget: number, floor = 300): string[] {
  const total = texts.reduce((sum, text) => sum + text.length, 0);
  if (total <= budget) return texts;
  const sorted = texts.map((text) => text.length).toSorted((a, b) => a - b);
  let left = budget;
  let cap = Math.max(floor, Math.floor(budget / texts.length));
  for (let i = 0; i < sorted.length; i += 1) {
    const share = Math.floor(left / (sorted.length - i));
    if (sorted[i]! > share) {
      cap = Math.max(floor, share);
      break;
    }
    left -= sorted[i]!;
    cap = Math.max(floor, share);
  }
  return texts.map((text) => (text.length <= cap ? text : `${text.slice(0, cap).trimEnd()} …(cut)`));
}

/** About how many characters fit in a context of `numCtx` tokens after `reserved` tokens are kept back. */
export const charsFor = (numCtx: number, reserved: number) => Math.max(4000, (numCtx - reserved) * 3);

/**
 * One call to a model, no tools and no long private reasoning (it only makes a report slower and can use up the
 * room for writing it). `cut`: the model stopped at its length limit, mid-answer.
 */
export async function askModel(
  services: Pick<Services, "ollamaLauncher" | "registry" | "catalog" | "runtime">,
  ref: ModelRef,
  system: string,
  user: string,
  options: { signal: AbortSignal; maxTokens: number; timeoutMs?: number; onText?: (text: string) => void },
): Promise<{ text: string; cut: boolean }> {
  const { ollamaLauncher, registry, catalog, runtime } = services;
  await ollamaLauncher.settled();
  const { provider, model } = registry.resolve(ref);
  // The time limit starts once Ollama is up, not while it's still starting.
  const signal = options.timeoutMs
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
    : options.signal;
  // Ollama is always told: its model list leaves thinking out for some models that do think (Ornith 1.5, MiMo
  // v2.6), and those spent a whole summary's room thinking, leaving it empty. Ollama accepts it from any model.
  const thinks =
    parseModelRef(ref).providerId === "ollama" ||
    (await catalog.info(ref))?.capabilities.includes("thinking");
  const think = thinks ? false : undefined;
  const call = async () => {
    let text = "";
    let cut = false;
    for await (const chunk of provider.chat({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      maxTokens: options.maxTokens,
      think,
      local: provider.local ? runtime.localOptions() : undefined,
      signal,
    })) {
      if (chunk.type === "done") cut = chunk.finishReason === "length";
      if (chunk.type !== "text") continue;
      text += chunk.text;
      options.onText?.(chunk.text);
    }
    return { text, cut };
  };
  return provider.local ? runtime.run("user", call, { signal }) : call();
}
