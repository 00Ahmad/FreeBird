/**
 * Parallel Bots: one request, one reply. The model picks three roles that fit the message and answers as each of
 * them in a single reply, in three sections. This module is the instruction that asks for it and the reader that
 * splits the reply back into sections (also while it is still streaming).
 */

export const PARALLEL_SECTIONS = 3;

/**
 * Added to the user's newest message for the one request that answers it (never saved with the message). Small
 * models follow a fill-in form better than a description of one, and the answers fit only if each stays short.
 */
export function parallelInstructions(): string {
  return [
    "(Parallel Bots mode. Answer the message above as three bots working side by side, in this one reply.",
    "First pick the three roles that suit this message best: three different viewpoints or kinds of expertise, each covering a different part of what was asked. Name each role in two to four words.",
    "Then write what each role answers, in its own voice. Every answer must be complete on its own: don't mention the other roles or repeat what they say. Keep each answer to what matters and about the same length as the others, so all three fit.",
    "Reply in exactly this form, with nothing before the first heading and nothing after the last answer:",
    "",
    "## 1. <role name>",
    "<answer of the first role>",
    "",
    "## 2. <role name>",
    "<answer of the second role>",
    "",
    "## 3. <role name>",
    '<answer of the third role>\n\nExample of the headings for the message "Should I rent or buy a flat?": "## 1. Financial planner", "## 2. Local estate agent", "## 3. Lifestyle coach".)',
  ].join("\n");
}

export interface ParallelSection {
  /** 1 to 3, in the order written. */
  index: number;
  /** The role the model chose; empty while its heading is still being written. */
  role: string;
  text: string;
}

export interface ParallelReply {
  /** Anything written before the first section. */
  before: string;
  sections: ParallelSection[];
}

/** A section's heading: `## 1. Role`, `### Agent 2: Role`, `**3 - Role**`. Plain "1. Role" lines are answers' own lists. */
const SECTION_HEADING =
  /^[ \t]{0,3}(#{1,6}|\*\*)[ \t]*(?:(?:agent|bot|role)[ \t]*)?([1-3])[ \t]*[.:)\-–—][ \t]*(.*?)[ \t]*$/i;

/** A role name without the bold marks, quotes and `<…>` a model copies from the form. */
const roleName = (raw: string) =>
  raw
    .replace(/\*\*$/, "")
    .trim()
    .replace(/^<(.*)>$/, "$1")
    .replace(/^["“'`]+|["”'`]+$/g, "")
    .trim();

/**
 * Splits a reply into its sections. A section starts at a heading numbered in order (1, then 2, then 3) in the same
 * kind as the first one, or a shallower one: a deeper heading inside an answer stays part of that answer. Headings
 * inside code blocks never count. Whatever isn't in a section is returned as `before`, so no text is ever lost.
 */
export function parseParallel(text: string): ParallelReply {
  const before: string[] = [];
  const sections: { index: number; role: string; body: string[] }[] = [];
  let kind: { bold: boolean; depth: number } | null = null;
  let inCode = false;
  for (const line of text.split("\n")) {
    const into = (sections.at(-1)?.body ?? before) as string[];
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      into.push(line);
      continue;
    }
    const heading = inCode ? null : SECTION_HEADING.exec(line);
    if (heading) {
      const marker = heading[1]!;
      const here = { bold: marker === "**", depth: marker.length };
      const fits = kind === null || (here.bold === kind.bold && (here.bold || here.depth <= kind.depth));
      if (Number(heading[2]) === sections.length + 1 && fits) {
        kind ??= here;
        sections.push({ index: sections.length + 1, role: roleName(heading[3]!), body: [] });
        continue;
      }
    }
    into.push(line);
  }
  return {
    before: before.join("\n").trim(),
    sections: sections.map((section) => ({
      index: section.index,
      role: section.role,
      text: section.body.join("\n").trim(),
    })),
  };
}
