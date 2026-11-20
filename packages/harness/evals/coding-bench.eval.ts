/**
 * The Coding Bot benchmark: fixed briefs, each run several times on a real local model in a fresh empty folder, and for
 * each run whether the result actually works (the page opens with a clean console and its main action works, or the
 * command prints the right answer), how long it took, how many rounds and turns, and how many turns did nothing or were
 * cut off. Run it before and after a change to the workflow, and compare.
 *
 *   pnpm --filter @mrog/harness exec tsx evals/coding-bench.eval.ts ornith-1.5:9b
 *   pnpm --filter @mrog/harness exec tsx evals/coding-bench.eval.ts ornith-1.5:9b --repeat=2 --only=todo,cli
 *   pnpm --filter @mrog/harness exec tsx evals/coding-bench.eval.ts ornith-1.5:9b --compare=evals/results/coding-bench-….json
 *
 * Options: --repeat=N (default 2), --only=name,name, --rounds=N (QA round limit, default 5), --minutes=N (time limit per
 * run, default 45), --ctx=N (context window, default 32768), --no-visual (Visual QA off), --compare=<results file>.
 * EVAL_OLLAMA_URL points it at an Ollama on another address. Results go to evals/results/ (git-ignored) as JSON and
 * Markdown. A full run (4 briefs × 2) on a 9B model can take a few hours and keeps the GPU busy.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { detectRun } from "@mrog/visual-qa";

import { checkProject } from "../src/coding-check";
import { quickVisualCheck } from "../src/visual-qa/quick";
import { runCodingProject, type RunOutput, type RunResult } from "./coding-run";

// ---- the briefs ----------------------------------------------------------------------------------------------------

interface Verdict {
  /** The result does what the brief asks, as far as the check can tell; null when it couldn't be checked. */
  works: boolean | null;
  why: string;
}

interface Brief {
  name: string;
  text: string;
  /** Whether the finished project works. */
  verify(output: RunOutput): Promise<Verdict>;
}

const filesOf = (output: RunOutput) => {
  const read = (path: string) => {
    const full = join(output.outDir, path);
    return existsSync(full) ? readFileSync(full, "utf8") : null;
  };
  return { files: output.project.nodes.map((node) => node.path), read };
};

/**
 * A web page opens in a hidden browser with a clean console, and the code checks find nothing. With `checks` (done
 * checks against the ids the brief names), it must also do what they say: the page is tried, not only opened.
 */
async function pageWorks(output: RunOutput, checks: string[] = []): Promise<Verdict> {
  const files = filesOf(output);
  const found = checkProject(files);
  if (found.length > 0) return { works: false, why: `code check: ${found[0]!.problem}` };
  const run = detectRun({ ...files, python: "python" });
  if (run.kind !== "page") return { works: false, why: `not a web page (${run.kind})` };
  const { findings, error, mismatches } = await quickVisualCheck({
    browser: output.services.browser,
    qaBotId: output.project.roles.qa.botId,
    outputFolder: output.outDir,
    files,
    run,
    refuse: () => null,
    signal: AbortSignal.timeout(120_000),
    ...(checks.length > 0 ? { done: [{ file: run.entry, checks }] } : {}),
  });
  if (error) return { works: null, why: `couldn't open the page: ${error}` };
  // The brief named these elements, so a page without them doesn't do what was asked.
  if (mismatches?.length) return { works: false, why: mismatches[0]! };
  return findings.length === 0
    ? {
        works: true,
        why:
          checks.length > 0
            ? `loads cleanly, and does what it should (${checks.length} checks)`
            : "loads cleanly, nothing missing, buttons wired",
      }
    : { works: false, why: findings[0]!.problem };
}

/** Runs node with the arguments in the project folder; what it printed, errors included. */
const node = (args: string[], cwd: string) =>
  new Promise<{ out: string }>((resolve) =>
    execFile(process.execPath, args, { cwd, timeout: 15_000 }, (_error, stdout, stderr) =>
      resolve({ out: `${stdout}${stderr}` }),
    ),
  );

const BRIEFS: Brief[] = [
  {
    name: "todo",
    text: "Build a small to-do list web page in plain HTML, CSS and JavaScript (no frameworks, no build step), with exactly three files: index.html, style.css and app.js. You type a task and click Add to put it in the list; clicking a task's Done button marks it done (struck through); its Delete button removes it.",
    verify: (output) => pageWorks(output),
  },
  {
    // The to-do page again, with the ids named, so the check can try it: whether it works, not only whether it opens.
    name: "todo-ids",
    text: [
      "Build a small to-do list web page in plain HTML, CSS and JavaScript (no frameworks, no build step), with exactly three files: index.html, style.css and app.js.",
      'The page has a text box with id "task", an Add button with id "add", and a list with id "tasks".',
      "Typing a task and clicking Add puts it in the list as a new item showing the task's text; the box is then emptied.",
      "Each item has a Done button (marks it done, struck through) and a Delete button (removes it).",
    ].join(" "),
    verify: (output) =>
      pageWorks(output, ['type #task "Buy milk" then click #add -> #tasks contains "Buy milk"']),
  },
  {
    name: "api",
    text: "Build a small web page in plain HTML, CSS and JavaScript (no frameworks, no build step) with three files: index.html, style.css and app.js. When the page opens it loads the users from https://jsonplaceholder.typicode.com/users and lists each user's name and email. A search box above the list filters it by name as you type. Show 'Loading…' while it loads, and a clear error message on the page if the request fails.",
    verify: (output) => pageWorks(output),
  },
  {
    name: "cli",
    text: "Build a tiny command-line tool in plain JavaScript (Node, no dependencies): `node src/main.js 3 4` prints the sum of its two number arguments, and an error message if an argument isn't a number. Keep the maths in its own file src/math.js (export add), the argument checking in src/args.js (export parseNumbers), and src/main.js ties them together. A README.md is not needed. Exactly three files.",
    verify: async (output) => {
      const main = join(output.outDir, "src", "main.js");
      if (!existsSync(main)) return { works: false, why: "src/main.js is missing" };
      const sum = await node(["src/main.js", "3", "4"], output.outDir);
      if (!/(^|\D)7(\D|$)/.test(sum.out))
        return { works: false, why: `3 4 printed: ${sum.out.trim().slice(0, 120)}` };
      const bad = await node(["src/main.js", "x", "4"], output.outDir);
      if (/(^|\D)NaN(\D|$)/.test(bad.out) || !bad.out.trim())
        return { works: false, why: `x 4 printed: ${bad.out.trim().slice(0, 120) || "(nothing)"}` };
      return { works: true, why: "3 4 → 7, and x 4 gives an error" };
    },
  },
];

// ---- options -------------------------------------------------------------------------------------------------------

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const flag = (name: string) =>
  args
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const model = args.find((arg) => !arg.startsWith("--"));
if (!model) {
  console.error("Name a model: coding-bench.eval.ts ornith-1.5:9b");
  process.exit(1);
}
const repeat = Number(flag("repeat") ?? 2);
const only = flag("only")?.split(",");
const briefs = BRIEFS.filter((brief) => !only || only.includes(brief.name));
const settings = {
  model,
  visualQa: !args.includes("--no-visual"),
  maxRounds: Number(flag("rounds") ?? 5),
  timeLimitMs: Number(flag("minutes") ?? 45) * 60_000,
  numCtx: Number(flag("ctx") ?? 32_768),
  ...(process.env.EVAL_OLLAMA_URL ? { ollamaUrl: process.env.EVAL_OLLAMA_URL } : {}),
};

interface Row extends Omit<RunResult, "activity"> {
  brief: string;
  run: number;
  works: boolean | null;
  why: string;
  /** Activity lines that matter for the workflow, counted. */
  events: Record<string, number>;
}

/** Activity lines worth counting, by what they say happened. */
const EVENTS: Record<string, RegExp> = {
  sentBack: / sent .+ back/,
  quickCheckSentBack: /^Visual QA's quick check sent /,
  codeCheckSentBack: /^The code check sent /,
  cutOff: /edits without finishing/,
  noToolsNudged: /replied without using (any|its) tools?/,
  modelFailed: /model failed/,
};

const count = (activity: string[]) =>
  Object.fromEntries(
    Object.entries(EVENTS).map(([name, pattern]) => [
      name,
      activity.filter((line) => pattern.test(line)).length,
    ]),
  );

// ---- reporting -----------------------------------------------------------------------------------------------------

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

interface Summary {
  brief: string;
  runs: number;
  works: number;
  medianSeconds: number;
  medianRounds: number;
  medianTurns: number;
  medianInputTokens: number;
  idleTurns: number;
  cutOffs: number;
  uncountedTurns: number;
}

const roleTotals = (row: Row, key: keyof Row["roles"]["planner"]) =>
  sum(Object.values(row.roles).map((stats) => stats[key]));

const summarize = (list: Row[]): Summary[] =>
  [...new Set(list.map((row) => row.brief))].map((name) => {
    const runs = list.filter((row) => row.brief === name);
    return {
      brief: name,
      runs: runs.length,
      works: runs.filter((row) => row.works === true).length,
      medianSeconds: median(runs.map((row) => row.seconds)),
      medianRounds: median(runs.map((row) => row.rounds)),
      medianTurns: median(runs.map((row) => roleTotals(row, "turns"))),
      medianInputTokens: median(runs.map((row) => roleTotals(row, "inputTokens"))),
      idleTurns: sum(runs.map((row) => roleTotals(row, "idleTurns"))),
      cutOffs: sum(runs.map((row) => row.events.cutOff ?? 0)),
      uncountedTurns: sum(runs.map((row) => roleTotals(row, "uncountedTurns"))),
    };
  });

const table = (list: Summary[], before?: Summary[]) => {
  const delta = (name: string, key: keyof Summary, value: number) => {
    const old = before?.find((entry) => entry.brief === name)?.[key];
    return typeof old === "number" && old !== value ? ` (was ${old})` : "";
  };
  const lines = [
    "| Brief | Works | Median time | Median rounds | Median turns | Median input tokens | Idle turns | Cut off | Turns not counted |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...list.map(
      (entry) =>
        `| ${entry.brief} | ${entry.works}/${entry.runs}${delta(entry.brief, "works", entry.works)} | ${entry.medianSeconds}s${delta(entry.brief, "medianSeconds", entry.medianSeconds)} | ${entry.medianRounds}${delta(entry.brief, "medianRounds", entry.medianRounds)} | ${entry.medianTurns}${delta(entry.brief, "medianTurns", entry.medianTurns)} | ${entry.medianInputTokens}${delta(entry.brief, "medianInputTokens", entry.medianInputTokens)} | ${entry.idleTurns} | ${entry.cutOffs} | ${entry.uncountedTurns} |`,
    ),
  ];
  return lines.join("\n");
};

const comparePath = flag("compare");
const before = comparePath
  ? (JSON.parse(readFileSync(comparePath, "utf8")) as { summary: Summary[] }).summary
  : undefined;

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const dir = join(import.meta.dirname, "results");
const base = join(dir, `coding-bench-${model.replace(/[^\w.-]+/g, "_")}-${stamp}`);

/** Writes the results so far: after every run, so a run that is cut off keeps what it measured. */
function save(rows: Row[], finished: boolean): string {
  const summary = summarize(rows);
  const report = [
    `# Coding Bot benchmark: ${model}`,
    "",
    `${startedAt.toISOString()} · ${repeat} run(s) per brief · Visual QA ${settings.visualQa ? "on" : "off"} · round limit ${settings.maxRounds} · context ${settings.numCtx}${finished ? "" : " · **unfinished**"}`,
    comparePath ? `Compared with ${comparePath}.` : "",
    "",
    "**Works** means: for a page, it loads with a clean console, nothing it links is missing and its buttons are wired to something (what a click does isn't checked); for the command-line tool, it prints the right sum and an error for a bad number.",
    "",
    table(summary, before),
    "",
    "## Runs",
    "",
    ...rows.map(
      (row) =>
        `- **${row.brief} ${row.run}**: ${row.works === true ? "works" : row.works === false ? "broken" : "unknown"} (${row.why}). ${row.status}, ${row.seconds}s, ${row.rounds} round(s), ${row.files} files, ${row.cards} cards; events ${JSON.stringify(row.events)}`,
    ),
  ].join("\n");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${base}.json`,
    JSON.stringify({ model, settings: { ...settings }, startedAt, finished, rows, summary }, null, 2),
  );
  writeFileSync(`${base}.md`, report);
  return report;
}

// ---- running -------------------------------------------------------------------------------------------------------

const rows: Row[] = [];
for (const brief of briefs)
  for (let run = 1; run <= repeat; run++) {
    console.log(`\n▶ ${brief.name} ${run}/${repeat} on ${model}…`);
    const { result, checked } = await runCodingProject({ ...settings, brief: brief.text }, (output) =>
      output.project.status === "done"
        ? brief.verify(output)
        : Promise.resolve({ works: false, why: `ended ${output.project.status}` }),
    );
    const { activity, ...rest } = result;
    const row: Row = {
      ...rest,
      brief: brief.name,
      run,
      works: checked.works,
      why: checked.why,
      events: count(activity),
    };
    rows.push(row);
    save(rows, false);
    console.log(
      `  ${row.works === true ? "WORKS" : row.works === false ? "BROKEN" : "UNKNOWN"} (${row.why}); ${row.status} in ${row.seconds}s, ${row.rounds} round(s)`,
    );
  }

console.log(`\n${save(rows, true)}`);
console.log(`\nSaved ${base}.json and .md`);
process.exit(0);
