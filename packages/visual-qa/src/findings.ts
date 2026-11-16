/**
 * Turns what the automatic part of Visual QA saw (how the app started, the browser's console, the controls on the
 * page) into findings: a planned file and what is wrong. Conservative on purpose, like the automatic code check: a
 * finding sends work back to the Developer, so each rule only speaks when it is sure.
 */

export interface Finding {
  /** The planned file to fix. */
  file: string;
  problem: string;
  /** Other planned files the problem spans (a script a page loads), so a connection's card can take it. */
  related?: string[];
}

/** Findings sent back at once: more than this is noise the Developer can't act on in one go. */
export const MAX_FINDINGS = 8;

const clip = (text: string, length: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};

const norm = (path: string) =>
  path
    .replaceAll("\\", "/")
    .replace(/^\.?\/+/, "")
    .toLowerCase();

/** The planned file a path names, matched without case and slash differences. */
export function plannedPath(candidate: string, planned: string[]): string | undefined {
  const wanted = norm(candidate);
  return planned.find((path) => norm(path) === wanted);
}

/** The planned file an address on the app's own origin serves, if it is one ("/js/app.js" → "js/app.js"). */
export function fileFromUrl(url: string, origin: string, planned: string[]): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== origin) return undefined;
    return plannedPath(decodeURIComponent(parsed.pathname), planned);
  } catch {
    return undefined;
  }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The planned file named last in some output (a traceback's deepest own frame, a stack line), by path with either
 * slash. Only whole path parts count: "app.py" doesn't match inside "myapp.py".
 */
export function fileFromText(text: string, planned: string[]): string | undefined {
  let best: { file: string; at: number } | undefined;
  for (const file of planned) {
    const pattern = file.split("/").map(escape).join("[\\\\/]");
    const regex = new RegExp(`(?:^|[\\s"'(\\\\/:@])${pattern}(?=$|[\\s"'):,])`, "gim");
    for (const match of text.matchAll(regex))
      if (!best || match.index > best.at) best = { file, at: match.index };
  }
  return best?.file;
}

/** The line of some output that says what went wrong: the last that looks like an error, else the last line. */
export function errorLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const error = lines.findLast((line) =>
    /(?:^|\b)(?:\w*Error|\w*Exception|Traceback|Uncaught|FATAL|failed|cannot|can't|not found)\b/i.test(line),
  );
  return clip(error ?? lines.at(-1) ?? "", 300);
}

/** A Python traceback or a Node crash in some output. */
const CRASH = /Traceback \(most recent call last\)|^\s*at .+:\d+:\d+\)?$|^Uncaught |^\w*Error: /m;

export interface LaunchResult {
  /** It came up: the server answered, or the window stayed open. */
  started: boolean;
  /** Its exit code when it stopped by itself (null while running). */
  exitCode: number | null;
  /** The last of what it printed. */
  output: string;
  /** It never came up in the time given, but didn't stop either. */
  timedOut?: boolean;
}

/**
 * The program a start command needs that isn't installed on this computer (Python, Node, npm…), or null. That is
 * not the Developer's to fix, so it stops Visual QA with a note instead of going back as a finding.
 */
export function missingProgram(output: string, exitCode: number | null): string | null {
  if (/Python was not found/i.test(output)) return "Python";
  const windows =
    /['"]?([\w.-]+)['"]? is not recognized as (?:the name of a cmdlet|an internal or external command)/i.exec(
      output,
    );
  if (windows) return windows[1]!;
  const sh = /(?:^|\n)(?:\/bin\/sh: )?(?:\d+: )?([\w.-]+): (?:command )?not found/.exec(output);
  if (sh) return sh[1]!;
  return exitCode === 9009 ? "the program the start command runs" : null;
}

/** What went wrong starting the app: it stopped, never came up, or printed a crash while running. */
export function launchFindings(result: LaunchResult, planned: string[], main: string): Finding[] {
  const file = fileFromText(result.output, planned) ?? main;
  const said = errorLine(result.output);
  if (!result.started && result.exitCode !== null)
    return [
      {
        file,
        problem: `The app stopped as soon as it started (exit code ${result.exitCode})${said ? `: ${said}` : ", without printing why"}. Make it start and keep running.`,
      },
    ];
  if (!result.started && result.timedOut)
    return [
      {
        file: main,
        problem: `The app never came up: it kept running but never answered on its address${said ? ` (it printed: ${said})` : ""}. Make it start its server and say where it listens.`,
      },
    ];
  if (CRASH.test(result.output))
    return [{ file, problem: `The app printed an error while running: ${said}. Fix what causes it.` }];
  return [];
}

/** Something the browser reported while the app's page was open. */
export type PageProblem =
  | { type: "error"; text: string; source?: string }
  | { type: "console"; text: string; source?: string }
  | { type: "request"; url: string; text: string }
  | { type: "response"; url: string; status: number };

export interface PageContext {
  /** The app's own origin (http://127.0.0.1:5173). */
  origin: string;
  planned: string[];
  /** The planned file of the page that was open (its HTML file, or the server's main file). */
  page: string;
  /** For a server app, the file that starts it: a server error goes back there. */
  main?: string;
}

/** Requests nobody needs to fix: the icon browsers ask for by themselves. */
const IGNORED = /\/favicon\.ico$|\/apple-touch-icon[^/]*\.png$/i;

/** Browser errors and failed loads on the app's own origin as findings, one per distinct problem. */
export function consoleFindings(problems: PageProblem[], context: PageContext): Finding[] {
  const { origin, planned, page } = context;
  const found: Finding[] = [];
  const seen = new Set<string>();
  const add = (finding: Finding) => {
    const key = `${finding.file}|${finding.problem}`;
    if (seen.has(key) || found.length >= MAX_FINDINGS) return;
    seen.add(key);
    found.push(finding);
  };
  for (const problem of problems) {
    if (problem.type === "error" || problem.type === "console") {
      // Errors from other sites (an ad, a CDN that is offline) aren't the project's to fix.
      if (problem.source && /^https?:/.test(problem.source) && !problem.source.startsWith(origin)) continue;
      const file =
        (problem.source && fileFromUrl(problem.source, origin, planned)) ??
        fileFromText(problem.text, planned) ??
        page;
      add({
        file,
        problem: `The page shows an error in the browser console: ${clip(problem.text, 300)}`,
        ...(file !== page ? { related: [page] } : {}),
      });
      continue;
    }
    if (!problem.url.startsWith(origin) || IGNORED.test(problem.url)) continue;
    const path = (() => {
      try {
        return decodeURIComponent(new URL(problem.url).pathname);
      } catch {
        return problem.url;
      }
    })();
    const target = plannedPath(path, planned);
    if (problem.type === "response" && problem.status >= 500) {
      add({
        file: context.main ?? page,
        problem: `The server answered ${path} with an error (HTTP ${problem.status}). Check the server's output for the cause.`,
      });
      continue;
    }
    const why = problem.type === "response" ? `HTTP ${problem.status}` : problem.text;
    if (problem.type === "request" && /BlockedByClient|ERR_ABORTED/i.test(why)) continue;
    add({
      file: page,
      problem: target
        ? `The page loads ${target}, but it failed to load (${why}). Make sure the path in the page matches the file.`
        : `The page loads ${path}, which isn't there (${why}). Point it at a file the project has, or remove it.`,
      ...(target && target !== page ? { related: [target] } : {}),
    });
  }
  return found;
}

/** A control on the page that a person couldn't use, found without a model. */
export interface ControlIssue {
  kind: "no-handler" | "covered" | "no-size";
  /** The words on it, or what it is when it has none. */
  label: string;
  /** What lies on top of it (for "covered"). */
  by?: string;
}

const named = (label: string) => (label ? `“${clip(label, 60)}”` : "a button with no name");

/**
 * Controls that can't work as findings on the page's file, with the scripts it loads as related files (a missing
 * handler is usually a script that never wires it up).
 */
export function controlFindings(issues: ControlIssue[], page: string, scripts: string[] = []): Finding[] {
  const related = scripts.filter((script) => script !== page);
  return issues.slice(0, MAX_FINDINGS).map((issue) => ({
    file: page,
    problem:
      issue.kind === "no-handler"
        ? `${named(issue.label)} does nothing when clicked: nothing handles its click (no handler on it or on anything around it, and it submits no form). Wire it up in the script this page loads.`
        : issue.kind === "covered"
          ? `${named(issue.label)} can't be clicked: ${issue.by ? `“${clip(issue.by, 60)}”` : "something else"} lies on top of it, so a click lands there instead. Fix the layout.`
          : `${named(issue.label)} is on the page but has no size, so it can't be seen or clicked. Fix its styles.`,
    ...(related.length > 0 ? { related } : {}),
  }));
}

/** Findings without repeats, at most MAX_FINDINGS. */
export function mergeFindings(...lists: Finding[][]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const finding of lists.flat()) {
    const key = `${finding.file}|${finding.problem}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

/** The findings as lines for QA's message and the activity list. */
export function formatFindings(findings: Finding[]): string {
  return findings.map((finding) => `- ${finding.file}: ${finding.problem}`).join("\n");
}
