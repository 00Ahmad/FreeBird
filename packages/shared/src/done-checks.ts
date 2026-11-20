/**
 * "Done when" checks: what a planned file must do, written by the Planner in a tiny fixed language and run by code in
 * the browser, so whether a page works is a fact, not QA's reading of the code. Few forms, each one line, so a small
 * model can write them and code can tell for sure whether one is written right.
 *
 *   #list has items                                    the element has at least one child (within a few seconds)
 *   #status contains "Ready"                           its text contains the words
 *   click #refresh -> #list changes                    clicking the first changes the second
 *   type #task "Buy milk" then click #add -> #list contains "Buy milk"
 */

export type DoneCheck =
  | { kind: "has-items"; target: string }
  | { kind: "contains"; target: string; text: string }
  | { kind: "click-changes"; click: string; target: string }
  | {
      kind: "type-click-contains";
      input: string;
      typed: string;
      click: string;
      target: string;
      text: string;
    };

/** The forms, as the Planner is shown them. */
export const DONE_FORMS = [
  "#list has items",
  '#status contains "Ready"',
  "click #refresh -> #list changes",
  'type #task "Buy milk" then click #add -> #list contains "Buy milk"',
];

/** The most checks a file may have, and the longest a check may be. */
export const MAX_DONE_CHECKS = 3;
export const MAX_DONE_LENGTH = 200;

/** A CSS selector as these checks take it: one word, an id, a class, a tag, or a simple combination of them. */
const SELECTOR = String.raw`([#.]?[A-Za-z_][\w-]*(?:[#.:\[][^\s"]*)*)`;
const ARROW = String.raw`\s*(?:->|→)\s*`;
const QUOTED = String.raw`"([^"]{1,80})"`;

const FORMS: [RegExp, (match: RegExpExecArray) => DoneCheck][] = [
  [new RegExp(`^${SELECTOR}\\s+has items$`, "i"), (m) => ({ kind: "has-items", target: m[1]! })],
  [
    new RegExp(`^${SELECTOR}\\s+contains\\s+${QUOTED}$`, "i"),
    (m) => ({ kind: "contains", target: m[1]!, text: m[2]! }),
  ],
  [
    new RegExp(`^click\\s+${SELECTOR}${ARROW}${SELECTOR}\\s+changes$`, "i"),
    (m) => ({ kind: "click-changes", click: m[1]!, target: m[2]! }),
  ],
  [
    new RegExp(
      `^type\\s+${SELECTOR}\\s+${QUOTED}\\s+then\\s+click\\s+${SELECTOR}${ARROW}${SELECTOR}\\s+contains\\s+${QUOTED}$`,
      "i",
    ),
    (m) => ({
      kind: "type-click-contains",
      input: m[1]!,
      typed: m[2]!,
      click: m[3]!,
      target: m[4]!,
      text: m[5]!,
    }),
  ],
];

/** A check written in one of the forms, or why it isn't. */
export function parseDoneCheck(written: string): DoneCheck | { error: string } {
  const text = written.trim().replace(/\s+/g, " ");
  if (!text) return { error: "the check is empty" };
  if (text.length > MAX_DONE_LENGTH)
    return { error: `the check is ${text.length} characters; keep it under ${MAX_DONE_LENGTH}` };
  for (const [pattern, make] of FORMS) {
    const match = pattern.exec(text);
    if (match) return make(match);
  }
  return {
    error: `“${text}” isn't one of the forms a check can take: ${DONE_FORMS.map((form) => `“${form}”`).join(", ")}`,
  };
}

/** The selectors a check needs on the page. */
export function selectorsOf(check: DoneCheck): string[] {
  switch (check.kind) {
    case "has-items":
    case "contains":
      return [check.target];
    case "click-changes":
      return [check.click, check.target];
    case "type-click-contains":
      return [check.input, check.click, check.target];
  }
}
