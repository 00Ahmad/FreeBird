import { DONE_FORMS, MAX_DONE_CHECKS, parseDoneCheck, type CodingNode } from "@mrog/shared";

/**
 * A plan's "done when" checks: read from what the Planner sent, and passed on to the Developer and QA. The checks
 * themselves live in @mrog/shared (their forms) and ./visual-qa/done-run (running them in the browser).
 */

/** The checks a plan entry carries, each written in one of the forms, or why they aren't. None is fine. */
export function readDone(raw: unknown, label: string): { done?: string[]; errors: string[] } {
  if (raw === undefined || raw === null || raw === "") return { errors: [] };
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null;
  if (!list) return { errors: [`${label}: "done" must be a list of checks, like ["${DONE_FORMS[0]}"].`] };
  const errors: string[] = [];
  if (list.length > MAX_DONE_CHECKS)
    errors.push(
      `${label}: ${list.length} done checks; give at most ${MAX_DONE_CHECKS}, the ones that matter most.`,
    );
  const done: string[] = [];
  list.slice(0, MAX_DONE_CHECKS).forEach((item, index) => {
    const text = typeof item === "string" ? item.trim().replace(/\s+/g, " ") : "";
    const parsed = parseDoneCheck(text);
    if ("error" in parsed) errors.push(`${label}: done check ${index + 1}: ${parsed.error}.`);
    else done.push(text);
  });
  return done.length > 0 ? { done, errors } : { errors };
}

/** What the Planner is told about done checks. */
export const DONE_GUIDANCE = [
  'For a web page, give the files that make it work a "done" list: up to 3 checks the browser runs on the page once the file is written, so whether it works is tested, not guessed. Each check is one line in one of these forms, using the ids you plan for the page:',
  ...DONE_FORMS.map((form) => `  ${form}`),
  'Check what the brief asks for (the list fills, the search finds, the add button adds), not how it looks. Leave "done" out for files no browser can check (styles, data, a server\'s code).',
].join("\n");

/**
 * The checks of a file, as the Developer and QA are shown them; null when it has none. `run`: whether the browser runs
 * them (Visual QA on). When it doesn't, they say so, so QA checks them by reading instead of leaving them to nobody.
 */
export function doneLines(node: Pick<CodingNode, "path" | "done"> | undefined, run: boolean): string | null {
  if (!node?.done?.length) return null;
  return [
    run
      ? `${node.path} is done when (the browser checks these on the page; they must pass):`
      : `${node.path} is done when these hold on the page (Visual QA is off, so nothing runs them: check them in the code):`,
    ...node.done.map((check) => `- ${check}`),
  ].join("\n");
}

/** The written files' checks, ready to run; `only` keeps one file's. */
export function doneFiles(
  nodes: Pick<CodingNode, "path" | "done">[],
  written: (path: string) => boolean,
  only?: string,
): { file: string; checks: string[] }[] {
  return nodes.flatMap((node) =>
    node.done?.length &&
    written(node.path) &&
    (only === undefined || node.path.toLowerCase() === only.toLowerCase())
      ? [{ file: node.path, checks: node.done }]
      : [],
  );
}
