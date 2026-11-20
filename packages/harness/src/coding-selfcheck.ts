import { Script } from "node:vm";

import {
  checkProject,
  extensionOf,
  isHtml,
  usesModuleSyntax,
  type CheckInput,
  type Finding,
} from "./coding-check";

/**
 * The Developer's own check of what it just wrote, before QA sees it: the file must parse, and the code check must
 * find nothing in it that this file can fix. The errors go back in the same turn, as finish_card's answer, with the
 * exact message and line, so the Developer fixes them with what it wrote still in front of it. Plain code, no model,
 * no child process: inside the installed app the harness runs under Electron, where "run node" would start the app.
 */

/** How many times a Developer turn is sent back to fix what its own check found, before the card goes on anyway. */
export const SELF_FIXES = 2;

const SCRIPT = new Set(["js", "mjs", "cjs"]);

/** Where a syntax error is, from the stack of a script compiled under `filename`: "line 12". */
function lineOf(error: Error, filename: string, shift: number): string {
  const match = new RegExp(`${filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`).exec(
    error.stack ?? "",
  );
  const line = match ? Number(match[1]) - shift : NaN;
  return Number.isFinite(line) && line > 0 ? ` at line ${line}` : "";
}

/**
 * Whether a JavaScript or JSON file parses; the problem if not. A module (import/export) is checked as the body of an
 * async function with its import and export keywords taken out, so top-level await is allowed; an error that is about
 * module syntax itself is never reported (that is the transformation, not the file).
 */
export function syntaxProblem(path: string, text: string): string | null {
  const extension = extensionOf(path);
  if (extension === "json") {
    try {
      JSON.parse(text);
      return null;
    } catch (error) {
      return `${path} is not valid JSON: ${(error as Error).message}.`;
    }
  }
  if (!SCRIPT.has(extension)) return null;
  const module = extension === "mjs" || usesModuleSyntax(text);
  const filename = "selfcheck-target.js";
  const source = module
    ? `(async () => {\n${text
        .replace(/^([ \t]*)import\s+[^;\n]*?from\s*["'][^"']+["'];?/gm, "$1")
        .replace(/^([ \t]*)import\s*["'][^"']+["'];?/gm, "$1")
        .replace(/^([ \t]*)export\s+default\s+/gm, "$1const __default = ")
        .replace(/^([ \t]*)export\s*\{[^}]*\}(?:\s*from\s*["'][^"']+["'])?;?/gm, "$1")
        .replace(/^([ \t]*)export\s+\*[^;\n]*;?/gm, "$1")
        .replace(/^([ \t]*)export\s+/gm, "$1")}\n})`
    : text;
  try {
    // Compiling is the check: the script is never run.
    const compiled = new Script(source, { filename });
    void compiled;
    return null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) return null;
    // About the module wrapper, not the file: say nothing rather than send good code back.
    if (module && /import|export|module|await|return/i.test(error.message)) return null;
    return `${path} doesn't parse: ${error.message}${lineOf(error, filename, module ? 1 : 0)}.`;
  }
}

/**
 * What the code check finds that this file's own card can fix: findings in this file, without the ones about files the
 * plan has that aren't written yet (a page written first "loads app.js, but there is no such file" is not wrong).
 */
export function ownFindings(path: string, findings: Finding[], files: CheckInput): Finding[] {
  const lower = path.toLowerCase();
  const unwritten = files.files.filter((file) => files.read(file) === null).map((file) => file.toLowerCase());
  // A page's problem that spans other files (a button that does nothing, a script loaded the wrong way) is usually
  // fixed in the script; the QA pass sends it to every file involved. A script's own error stays its own.
  const page = isHtml(path);
  return findings.filter(
    (finding) =>
      finding.file.toLowerCase() === lower &&
      !(page && (finding.related ?? []).length > 0) &&
      !unwritten.some(
        (file) =>
          finding.problem.toLowerCase().includes(file) ||
          (finding.related ?? []).some((related) => related.toLowerCase() === file),
      ),
  );
}

/** Everything the self-check finds in one file: does it parse, and what the code check finds that it can fix. */
export function selfCheck(path: string, files: CheckInput): string[] {
  const text = files.read(path);
  if (text === null) return [];
  const syntax = syntaxProblem(path, text);
  if (syntax) return [syntax];
  return ownFindings(path, checkProject(files), files).map((finding) => finding.problem);
}

/** finish_card's answer when the self-check found something: the problems, and what to do. */
export const notFinished = (path: string, problems: string[]) =>
  [
    `Not finished: the checks of ${path} found ${problems.length === 1 ? "a problem" : `${problems.length} problems`}:`,
    ...problems.map((problem) => `- ${problem}`),
    `Fix ${problems.length === 1 ? "it" : "them"} in ${path} now (edit_file, or write_file for the whole file), then call finish_card again.`,
  ].join("\n");
