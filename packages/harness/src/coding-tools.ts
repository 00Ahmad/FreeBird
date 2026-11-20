import { statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  MAX_PLAN_FILES,
  SKILL_TOOLS,
  type CardComment,
  type CodingCard,
  type CodingProject,
  type CodingRole,
} from "@mrog/shared";
import { defineTool, resolvePath, safe, type ToolSpec } from "@mrog/tools";
import { VISUAL_QA_SCREEN_TOOLS, VISUAL_QA_TOOLS } from "@mrog/visual-qa";

import { DONE_GUIDANCE, doneLines } from "./coding-done";
import { validatePlan } from "./coding-plan";
import { flagged } from "./coding-replan";
import { USER_NOTE_FIRST, userSpokeLast } from "./coding-user-notes";
import { notFinished, SELF_FIXES } from "./coding-selfcheck";

/** Tools the Planner and QA use to look around. No `update_plan`: the loop is the team's checklist. */
const LOOK = ["list_files", "read_file", "search_files"];

/**
 * The tools each role has, and nothing else: no `spawn_bot`, `delegate`, `message_bot`, `dismiss_bot`, no web, no
 * browser. The planner cannot write files or run commands. The Developer writes files but runs nothing: QA runs and tests
 * the code (each command still asks the user) and changes no files itself. The Developer only reads the files its card
 * names: listing and searching the folder is how small models ended up reading 20 files and writing none. Every role
 * can also find and use skills (a guide for a review, a test plan, a debugging routine), unless the Coding Bot's
 * "Can use skills" switch is off.
 */
export const ROLE_TOOLS: Record<CodingRole, string[]> = {
  planner: [...LOOK, "propose_plan", ...SKILL_TOOLS],
  developer: ["read_file", "write_file", "edit_file", "finish_card", ...SKILL_TOOLS],
  qa: [...LOOK, "run_command", "review_card", "finish_check", ...SKILL_TOOLS],
};

/** QA's tools during Visual QA only, on top of its own: the running app, the screen, and the Visual QA verdict. */
export const VISUAL_QA_TURN_TOOLS: readonly string[] = [
  ...Object.values(VISUAL_QA_TOOLS),
  ...VISUAL_QA_SCREEN_TOOLS,
];

/** What each role bot's tool list allows: its role's tools, and for QA the Visual QA ones (offered in that turn only). */
export const ROLE_ALLOWED: Record<CodingRole, string[]> = {
  ...ROLE_TOOLS,
  qa: [...ROLE_TOOLS.qa, ...VISUAL_QA_TURN_TOOLS],
};

/**
 * The most model rounds a Developer turn gets (one reply and the tool calls in it is one round): one card is one file, so
 * a turn that needs more is going round in circles.
 */
export const DEVELOPER_MAX_STEPS = 15;
/** Rounds left when a Developer that hasn't written its file yet is told to write it now. */
export const DEVELOPER_STEER_AT = 3;
/** Distinct files a Developer try may read before it is told to write. */
export const DEVELOPER_MAX_READS = 6;

/** What a role's turn handed back, filled in by its own tools and read by the loop when the turn ends. */
export interface TurnCapture {
  /** The card being worked on (for the Developer's check that the file is there). */
  card?: { id: string; kind: "file" | "connector"; path?: string };
  /** QA's check of the whole project (it gets finish_check only), not a card review. */
  finalCheck?: boolean;
  /** QA's Visual QA of the running app (it gets the app and screen tools, and finish_visual_check only). */
  visual?: boolean;
  /** The distinct files read so far, as the role named them (the Developer's read budget). */
  reads?: string[];
  /** Model rounds so far (counted by the Developer's steer hook). */
  steps?: number;
  /** The Developer was told it is running out of rounds. */
  steered?: boolean;
  /** A write_file or edit_file of the card's files went through in this turn. */
  wrote?: boolean;
  /** Writes and edits of its files the Developer made in this turn (see coding-runaway.ts). */
  edits?: number;
  /** The turn was ended for making too many edits without finishing; its work goes on as it is. */
  cutOff?: boolean;
  /** Ends this turn at once (set by runRole). */
  stop?: () => void;
  /** The turn has made a tool call, even a refused one (see coding-idle.ts). */
  usedTool?: boolean;
  /** The turn was told once to use its tools, having called none. */
  idleNudged?: boolean;
  /** Times finish_card answered "Not finished" because the self-check found problems (see coding-selfcheck.ts). */
  selfFixes?: number;
  /** What the self-check found the last time it ran. */
  selfProblems?: string[];
  plan?: Extract<ReturnType<typeof validatePlan>, { ok: true }>;
  /** What was wrong with the last plan the tool turned down, for the retry. */
  rejected?: string[];
  finished?: { note: string };
  /** `planProblem`: QA says the plan itself is wrong (see coding-replan.ts). */
  review?: { pass: boolean; comment: string; planProblem?: boolean };
  /** QA's verdict on the whole project, once every card has passed. */
  check?: { ok: boolean; problems: { file: string; comment: string }[] };
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    nodes: {
      type: "array",
      description:
        "One entry per file of the project, in the order they should be built (files other files use first).",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the output folder, like src/main.py" },
          purpose: { type: "string", description: "What the code in this file should do" },
          done: {
            type: "array",
            items: { type: "string" },
            description:
              'For the files of a web page: up to 3 checks the browser runs, like "#list has items" or "click #add -> #list changes"',
          },
        },
        required: ["path", "purpose"],
      },
    },
    edges: {
      type: "array",
      description:
        "Connections between files. One connection can link two or more files. Leave the list empty if there are none.",
      items: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "The paths of the files it links (at least 2, each one of the nodes)",
          },
          description: { type: "string", description: "What connects them" },
        },
        required: ["files", "description"],
      },
    },
  },
  required: ["nodes"],
} as const;

/** `propose_plan`: the Planner hands in the files and connections. A plan that doesn't hold up is answered with why. */
export const proposePlanTool = (capture: TurnCapture): ToolSpec =>
  defineTool({
    name: "propose_plan",
    description:
      "Send the project plan: nodes (a file each, with its path and what its code should do) and edges (connections between two or more files, with what connects them). Call it once with the whole plan.",
    jsonSchema: PLAN_SCHEMA,
    args: z.object({ nodes: z.any(), edges: z.any().optional() }),
    risk: () => safe("Send the plan"),
    run: async (args) => {
      const result = validatePlan({ nodes: args.nodes, edges: args.edges ?? [] });
      if (!result.ok) {
        capture.rejected = result.errors;
        return `The plan was not accepted:\n${result.errors.map((error) => `- ${error}`).join("\n")}\nFix these and call propose_plan again with the whole plan.`;
      }
      capture.plan = result;
      const dropped = result.dropped?.length
        ? ` These done checks were left out, as they aren't in one of the forms (no need to send them again):\n${result.dropped.map((line) => `- ${line}`).join("\n")}\n`
        : " ";
      return `Plan accepted: ${result.nodes.length} files, ${result.edges.length} connections.${dropped}Reply with one short sentence and stop; don't write the plan out again.`;
    },
  });

/** `finish_card`: the Developer says the card is ready for QA. A file that isn't there yet is not ready. */
/**
 * `finish_card`. With `check`, what the Developer wrote is checked first (see coding-selfcheck.ts): while it finds
 * problems, the answer is "Not finished" with them, up to SELF_FIXES times a turn; then the card goes on anyway.
 */
export const finishCardTool = (
  capture: TurnCapture,
  check?: (signal: AbortSignal) => Promise<string[]>,
): ToolSpec =>
  defineTool({
    name: "finish_card",
    description:
      "Say that your card is finished and ready for QA, with a one-sentence note on what you did. Call it when the work is done, not before.",
    args: z.object({ note: z.string().trim().max(1000).optional() }),
    risk: () => safe("Hand the card to QA"),
    run: async (args, ctx) => {
      // Called again after the card was handed on (a small model may call it a dozen times): the turn ends here.
      if (capture.finished) {
        capture.stop?.();
        return "Already finished: the card is with QA. Stop now.";
      }
      const card = capture.card;
      if (card?.kind === "file" && card.path) {
        const { abs } = resolvePath(ctx.workspace, card.path);
        const size = (() => {
          try {
            return statSync(abs).isFile() ? statSync(abs).size : -1;
          } catch {
            return -1;
          }
        })();
        if (size < 0)
          return `The file ${card.path} doesn't exist yet. Write it with write_file first, then call finish_card.`;
        if (size === 0) return `The file ${card.path} is empty. Write its code first, then call finish_card.`;
        if (check && (capture.selfFixes ?? 0) < SELF_FIXES) {
          const problems = await check(ctx.signal);
          if (problems.length > 0) {
            capture.selfFixes = (capture.selfFixes ?? 0) + 1;
            capture.selfProblems = problems;
            return notFinished(card.path, problems);
          }
          capture.selfProblems = [];
        }
      }
      capture.finished = { note: args.note ?? "" };
      return "The card is with QA now. Reply with one short sentence and stop.";
    },
  });

const PASS = /^(pass|passed|passes|ok|approve|approved|accept|accepted|good|true)$/i;
const FAIL = /^(fail|failed|fails|reject|rejected|no|bad|false)$/i;

/** `review_card`: QA's verdict. A fail must say what is wrong, because the Developer gets nothing else. */
export const reviewCardTool = (capture: TurnCapture): ToolSpec =>
  defineTool({
    name: "review_card",
    description:
      "Give your verdict on the card: verdict is pass or fail. A fail needs a comment saying exactly what is wrong and how to fix it. Call it once, after you have looked at the code.",
    jsonSchema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["pass", "fail"] },
        comment: { type: "string", description: "Required for a fail: what is wrong and how to fix it" },
        plan_problem: {
          type: "boolean",
          description:
            "Only with a fail, and only when no change to this file alone can fix it because the plan itself is wrong: a file the plan is missing, a job planned into the wrong file, or a file doing far too much. Leave it out for a bug in the code.",
        },
      },
      required: ["verdict"],
    },
    // Models send the verdict under other names, and as a boolean.
    prepare: (args) => {
      const verdict = args.verdict ?? args.result ?? args.status ?? args.passed ?? args.pass;
      return {
        verdict: typeof verdict === "boolean" ? (verdict ? "pass" : "fail") : verdict,
        comment: args.comment ?? args.reason ?? args.feedback ?? args.notes ?? args.note,
        plan_problem: args.plan_problem ?? args.planProblem,
      };
    },
    args: z.object({
      verdict: z.string().refine((value) => PASS.test(value.trim()) || FAIL.test(value.trim()), {
        message: 'must be "pass" or "fail"',
      }),
      comment: z.string().trim().max(4000).optional(),
      plan_problem: z.unknown().optional(),
    }),
    risk: () => safe("Review the card"),
    run: async (args) => {
      const pass = PASS.test(args.verdict.trim());
      const comment = args.comment ?? "";
      if (!pass && !comment)
        return "A fail needs a comment: say exactly what is wrong and how to fix it. Call review_card again with verdict fail and a comment.";
      capture.review = {
        pass,
        comment,
        ...(!pass && flagged(args.plan_problem) ? { planProblem: true } : {}),
      };
      return `Verdict recorded: ${pass ? "pass" : "fail"}. Reply with one short sentence and stop.`;
    },
  });

const BSN = "\n";

/**
 * `finish_check`: QA's verdict on the whole project once every card has passed. A problem must name a planned file and say
 * what is wrong, because that file's card goes back to the Developer with the comment and nothing else.
 */
export const finishCheckTool = (
  capture: TurnCapture,
  planned: () => string[],
  name: "finish_check" | "finish_visual_check" = "finish_check",
): ToolSpec =>
  defineTool({
    name,
    description:
      name === "finish_visual_check"
        ? "Give your verdict after using the app: ok true if everything you tried worked, or ok false with problems (each one a planned file path and a comment saying what you did, what should have happened and what happened). Call it once, at the end."
        : "Give your verdict on the whole project after the final check: ok true if it would work when opened or run, or ok false with problems (each one a planned file path and a comment saying what is wrong and how to fix it). Call it once.",
    jsonSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean", description: "True when nothing would stop the project working" },
        problems: {
          type: "array",
          description: "What is wrong; required when ok is false",
          items: {
            type: "object",
            properties: {
              file: { type: "string", description: "The planned file the problem is in" },
              comment: { type: "string", description: "What is wrong and how to fix it" },
            },
            required: ["file", "comment"],
          },
        },
      },
      required: ["ok"],
    },
    // Small models send the list as a string of JSON, or one problem alone.
    prepare: (args) => {
      let problems: unknown = args.problems;
      if (typeof problems === "string") {
        try {
          problems = JSON.parse(problems);
        } catch {
          // left as is: validation says what is wrong
        }
      }
      if (problems && !Array.isArray(problems) && typeof problems === "object") problems = [problems];
      return { ok: args.ok ?? args.pass ?? args.passed, problems };
    },
    args: z.object({
      ok: z.boolean(),
      problems: z.array(z.object({ file: z.string(), comment: z.string() })).optional(),
    }),
    risk: () => safe("Give the final verdict"),
    run: async (args) => {
      const known = planned();
      const given = args.problems ?? [];
      if (args.ok && given.length > 0)
        return `ok is true but you listed problems. Call ${name} again: ok false with the problems, or ok true with none.`;
      if (!args.ok && given.length === 0)
        return `ok is false but you listed no problems. Call ${name} again with each problem (a planned file and a comment saying what is wrong).`;
      const problems: { file: string; comment: string }[] = [];
      for (const problem of given) {
        const file = known.find(
          (path) => path.toLowerCase() === problem.file.trim().replaceAll("\\", "/").toLowerCase(),
        );
        if (!file)
          return `"${problem.file}" is not one of the project's files. Files: ${known.join(", ")}. Call ${name} again.`;
        if (!problem.comment.trim())
          return `The problem in ${file} has no comment. Say exactly what is wrong and how to fix it, and call ${name} again.`;
        problems.push({ file, comment: problem.comment.trim() });
      }
      capture.check = { ok: args.ok, problems };
      return `Verdict recorded: ${args.ok ? "ok" : `${problems.length} problem${problems.length === 1 ? "" : "s"}`}. Reply with one short sentence and stop.`;
    },
  });

// ---- what each role is told -------------------------------------------------------------------------------

export const ROLE_NAMES: Record<CodingRole, string> = {
  planner: "Planner",
  developer: "Developer",
  qa: "QA",
};

/** The standing rules of a role: added to its prompt on every turn. */
export function roleRules(role: CodingRole, outputFolder: string): string {
  const common = `You are on a small software team (Planner, Developer, QA) that builds one project in the output folder ${outputFolder}. Your working folder is that folder: use paths relative to it. Nobody is available to answer questions in this chat, so make sensible choices instead of asking. Each message you get stands on its own.`;
  if (role === "planner")
    return `${common} You are the Planner: you plan, you never write code or run commands. Look at the folder with list_files first (it may already hold files). Then call propose_plan with every file the project needs (a path and what its code should do, in build order) and the connections between files (what one file uses from another).`;
  if (role === "developer")
    return `${common} You are the Developer: you get one card at a time, a file to write or a connection between files to make work. Write only what the card is about, complete and working, once, with write_file (or edit_file to fix it), then call finish_card straight away. Other files belong to other cards. Never make helper, scratch, test, backup or temporary files or scripts. You cannot run commands: QA runs and tests the work. Never invent an API key, token, password or any other secret: if a file needs one only the user can supply, write a clearly marked placeholder such as YOUR_API_KEY_HERE and a comment saying where to get a real one.`;
  return `${common} You are QA: you get one card at a time and review it. You run and test the code: read it with read_file, install the packages it needs and run the project or its tests with run_command (a command may need the user's approval first), then call review_card with pass or fail. You don't change files. A clearly marked placeholder (YOUR_API_KEY_HERE) for a secret only the user can provide is correct: accept it and never ask for a real key. Fail a file that contains what looks like a real secret someone made up. A fail needs a comment saying exactly what is wrong and how to fix it, because the Developer sees nothing else.`;
}

/** A card's comments under a heading, with the user's note put first when it is the newest word. */
const cardNotes = (card: CodingCard, heading: string): string =>
  card.comments.length === 0
    ? ""
    : [heading, notes(card.comments), ...(userSpokeLast(card.comments) ? [USER_NOTE_FIRST] : [])].join(BSN);

const COMMENT_LABEL: Record<CardComment["author"], string> = {
  planner: "Planner",
  developer: "Developer",
  qa: "QA",
  // Read by the roles, to whom "You" would mean themselves.
  user: "The user",
};

const notes = (comments: CardComment[]) =>
  comments
    .map((comment) => `- ${COMMENT_LABEL[comment.author]} (round ${comment.round}): ${comment.text}`)
    .join("\n");

const FORMAT_EXAMPLE = [
  "```json",
  '{"nodes": [{"path": "src/main.py", "purpose": "what the code in it does"}, {"path": "src/util.py", "purpose": "…"}], "edges": [{"files": ["src/main.py", "src/util.py"], "description": "what connects them"}]}',
  "```",
].join("\n");

/** The Planner's job for one turn: the brief, and for a retry or a revision what was wrong or asked for. */
export function plannerMessage(
  project: CodingProject,
  extra: {
    problems?: string[];
    revision?: string;
    built?: boolean;
    /** The revision is a re-plan for cards that keep failing (see coding-replan.ts), not the user's change. */
    replan?: boolean;
    /** The plan was turned down twice: ask for a short one instead (see SHORT_PLAN). */
    short?: boolean;
    /** What the Planner is told about files in the folder from before the project (see coding-existing.ts). */
    existing?: string | null;
  } = {},
): string {
  const parts = [
    `The user's brief:\n${project.brief}`,
    `Plan the project. List every file it needs (a path relative to ${project.outputFolder}, with forward slashes, and what the code in that file should do) in the order they should be built, files others use first. Then list the connections: each links two or more of those files and says what connects them (a function one calls from the other, a type they share, a file both read). At most ${MAX_PLAN_FILES} files. Plan only what the brief needs.`,
    SMALL_FILES,
    DONE_GUIDANCE,
    ...(extra.existing ? [extra.existing] : []),
    "Send it by calling propose_plan. If you can't call tools, reply with the plan as one JSON code block like this and nothing else:",
    FORMAT_EXAMPLE,
  ];
  if (project.nodes.length > 0 && extra.revision) {
    const current = {
      nodes: project.nodes.map(({ path, purpose, done }) => ({ path, purpose, ...(done ? { done } : {}) })),
      edges: project.edges.map((edge) => ({
        files: edge.files.map((id) => project.nodes.find((node) => node.id === id)?.path ?? id),
        description: edge.description,
      })),
    };
    // Files already built (Done cards) are kept only when the Planner keeps them word for word.
    const keep = project.cards.some((card) => card.column === "done")
      ? " Keep every file the change doesn't touch exactly as it is (the same path and purpose): only the files you add or whose purpose you change are written again."
      : "";
    parts.push(
      extra.built
        ? `The project was built from this plan, and its files are in the folder:\n\`\`\`json\n${JSON.stringify(current, null, 1)}\n\`\`\``
        : `Your current plan:\n\`\`\`json\n${JSON.stringify(current, null, 1)}\n\`\`\``,
      extra.replan
        ? `${extra.revision}\nSend the whole updated plan, not only the changes.${keep}`
        : extra.built
          ? `The user now asks for a change:\n${extra.revision}\nSend the whole updated plan, not only the changes.${keep}`
          : `The user looked at it and asks for changes:\n${extra.revision}\nSend the whole updated plan, not only the changes.${keep}`,
    );
  } else if (extra.revision) parts.push(`The user asks for:\n${extra.revision}`);
  if (extra.problems?.length)
    parts.push(
      `Your last plan was not accepted:\n${extra.problems.map((problem) => `- ${problem}`).join("\n")}\nSend the corrected whole plan.`,
    );
  if (extra.short) parts.push(SHORT_PLAN);
  // A short plan leaves done checks out: one thing less to get wrong.
  if (extra.short) parts.splice(parts.indexOf(DONE_GUIDANCE), 1);
  return parts.join("\n\n");
}

/**
 * Small files: one feature each, so a small model writes each in one go instead of 500 lines at once (and then
 * edits a big file by exact matches, which is where it goes round in circles). On a plain page the feature scripts
 * share their top-level names, so each keeps its code inside one name of its own.
 */
export const SMALL_FILES =
  "Keep every code file small: one feature per file, under about 150 lines. A page that does several things (a list, a search, a form, a chart) gets one script per feature and a short main.js that starts them. On a plain web page with no build step, the page loads them with one <script> tag each, the features first and main.js last, and each feature script keeps its code inside one name of its own, for example window.Feed = (() => { … return { start }; })(); so main.js calls Feed.start().";

/**
 * A plan turned down twice is usually too much for the model to get right in one go: long purposes, many connections,
 * one slip anywhere. The third try asks for less, which the team can still build: every file with one sentence, and no
 * connections, since the exact names are read from the code as it is written (see coding-contract.ts). It has to say
 * that it overrides the Planner's own skill, which asks for long purposes and full connections.
 */
export const SHORT_PLAN =
  "Your plan has been turned down twice, so send a SHORT plan this time. This overrides the coding-planner skill and the instructions above about purposes and connections: list every file with a purpose of ONE sentence (under 200 characters) saying what it does, and leave edges empty ([]). The exact names the files share are read from their code as they are written, so the plan doesn't need them. Check every path against the problems listed, then call propose_plan.";

/**
 * The project's files as one card needs them: what each file it connects to does, and the others by name only. A
 * small model given every file's description on every card loses its own task among them.
 */
const focusedOverview = (project: CodingProject, card: CodingCard) => {
  const linked = new Set(linkedPaths(project, card));
  const near = project.nodes.filter((node) => linked.has(node.path));
  const rest = project.nodes
    .filter((node) => !linked.has(node.path) && !(card.kind === "file" && node.id === card.ref))
    .map((node) => node.path);
  return [
    near.length > 0
      ? `The files this card connects to:\n${near.map((node) => `- ${node.path}: ${node.purpose}`).join("\n")}`
      : "",
    rest.length > 0 ? `The project's other files (by name): ${rest.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

const overview = (project: CodingProject) =>
  `The project's files:\n${project.nodes.map((node) => `- ${node.path}: ${node.purpose}`).join("\n")}`;

/** The card as the Developer and QA read it: the file or the connection, with the files it concerns. */
export function cardSpec(project: CodingProject, card: CodingCard): string {
  if (card.kind === "file") {
    const node = project.nodes.find((candidate) => candidate.id === card.ref);
    const links = project.edges
      .filter((edge) => edge.files.includes(card.ref))
      .map(
        (edge) =>
          `- ${edge.description} (links ${edge.files.map((id) => project.nodes.find((n) => n.id === id)?.path ?? id).join(", ")})`,
      );
    return [
      `File: ${node?.path ?? card.title}`,
      `What the code in it should do: ${node?.purpose ?? ""}`,
      ...[doneLines(node, project.visualQa === true)].filter((line) => line !== null),
      ...(links.length > 0 ? [`Connections this file takes part in:\n${links.join("\n")}`] : []),
    ].join("\n");
  }
  const edge = project.edges.find((candidate) => candidate.id === card.ref);
  const files = (edge?.files ?? []).flatMap((id) => project.nodes.find((node) => node.id === id) ?? []);
  return [
    `Connection: ${edge?.description ?? card.title}`,
    `The files it links:\n${files.map((node) => `- ${node.path}: ${node.purpose}`).join("\n")}`,
  ].join("\n");
}

const position = (project: CodingProject, card: CodingCard) =>
  `card ${project.cards.indexOf(card) + 1} of ${project.cards.length}`;

/**
 * The files a card connects to, by path: for a file, the other files its connections link; for a connection, the
 * files it links. These are the only files the Developer is told to read.
 */
export function linkedPaths(project: CodingProject, card: CodingCard): string[] {
  const pathOf = (id: string) => project.nodes.find((node) => node.id === id)?.path;
  const ids =
    card.kind === "file"
      ? project.edges.filter((edge) => edge.files.includes(card.ref)).flatMap((edge) => edge.files)
      : (project.edges.find((edge) => edge.id === card.ref)?.files ?? []);
  return [...new Set(ids.filter((id) => id !== card.ref || card.kind === "connector"))].flatMap(
    (id) => pathOf(id) ?? [],
  );
}

/** Whether a planned file is in the output folder with something in it. */
export const writtenIn =
  (outputFolder: string) =>
  (path: string): boolean => {
    try {
      const info = statSync(join(outputFolder, path));
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  };

/**
 * The files a Developer turn may read: the linked files that are written (and the card's own file once it exists, so a
 * fix can read what it fixes), and the linked files a later card writes, which there is nothing to read in yet.
 */
export function readableFiles(
  project: CodingProject,
  card: CodingCard,
  written: (path: string) => boolean = writtenIn(project.outputFolder),
): { written: string[]; later: string[] } {
  const own = card.kind === "file" ? project.nodes.find((node) => node.id === card.ref)?.path : undefined;
  const linked = linkedPaths(project, card);
  return {
    written: [...(own && written(own) ? [own] : []), ...linked.filter(written)],
    later: linked.filter((path) => !written(path)),
  };
}

/** What happened in a Developer try that didn't finish its card, for the next try's message. */
export interface LastTry {
  /** Distinct files it read. */
  reads: number;
  /** The card's file (or, for a connection, one of its files) changed. */
  wrote: boolean;
  /** It used up its rounds. */
  stepLimit: boolean;
  /** The model failed with this error. */
  error?: string;
  /** What the checks found in what it wrote (see coding-selfcheck.ts). */
  problems?: string[];
}

const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

function lastTryLine(card: CodingCard, own: string, last: LastTry): string {
  const what = last.error
    ? `stopped with an error (${last.error})`
    : last.wrote
      ? `${card.kind === "file" ? `wrote ${own}` : "changed the files"}, but finish_card was not called`
      : `read ${files(last.reads)} and wrote nothing`;
  const found =
    last.problems && last.problems.length > 0
      ? ` The checks of what it wrote found:\n${last.problems.map((problem) => `- ${problem}`).join("\n")}\nFix ${last.problems.length === 1 ? "it" : "them"} first.`
      : "";
  return `Your last try ${what}${last.stepLimit && !last.error ? ", and it hit the step limit" : ""}.${found}`;
}

/** The Developer's job for one card. It carries everything needed: the Developer reads no earlier chat. */
export function developerMessage(
  project: CodingProject,
  card: CodingCard,
  last?: LastTry | null,
  written: (path: string) => boolean = writtenIn(project.outputFolder),
  /** The exact names read from the code of the files around this one (see coding-contract.ts). */
  contract?: string | null,
): string {
  const history = cardNotes(card, "Earlier notes on this card:");
  const linked = linkedPaths(project, card);
  const own = project.nodes.find((node) => node.id === card.ref)?.path ?? card.title;
  const readable = readableFiles(project, card, written);
  const readList = [
    readable.written.length > 0
      ? `Files already written (read these only if you need them, and no others): ${readable.written.join(", ")}.`
      : linked.length === 0
        ? "This card connects to no other file, so you don't need to read anything else."
        : "",
    readable.later.length > 0
      ? `Not written yet (a later card writes them): ${readable.later.join(", ")}. Don't read them: follow the connection description instead.`
      : "",
    `Read at most ${DEVELOPER_MAX_READS} files in all, then write.`,
  ]
    .filter(Boolean)
    .join(" ");
  const rules =
    card.kind === "file"
      ? [
          `Write only this file: ${own}. Write it once, in full, with write_file (if it exists and QA found problems, fix it with edit_file or write it again).`,
          "Do not write any other file: the other files are other cards, done in other turns.",
          ...(linked.length > 0
            ? [
                "Make this file's side of its connections work: use exactly the names the other files have (element ids, classes, functions, exports, data fields), reading the ones already written rather than guessing.",
              ]
            : []),
          "Make no helper, scratch, verification, duplicate, backup or temporary files or scripts. You can't run commands: QA runs and tests the work.",
          readList,
          "Call finish_card straight after writing, with a one-sentence note.",
        ]
      : [
          `Make this connection work by editing only the files it links (${linked.join(", ")}): add the missing calls, imports or shared parts, and don't rewrite what already works.`,
          "Make no helper, scratch, verification, duplicate, backup or temporary files or scripts. You can't run commands: QA runs and tests the work.",
          `Read only those files and don't re-read the rest of the project. ${readList}`,
          "Call finish_card straight after the edits, with a one-sentence note.",
        ];
  return [
    `Project brief: ${project.brief}`,
    `Output folder (your working folder): ${project.outputFolder}`,
    focusedOverview(project, card),
    `YOUR CARD (${position(project, card)}, round ${project.round + 1}):\n${cardSpec(project, card)}`,
    contract ?? "",
    history,
    `Rules for this card:\n${rules.map((rule) => `- ${rule}`).join("\n")}`,
    last
      ? [
          lastTryLine(card, own, last),
          readable.written.length > 0
            ? `Written so far: ${readable.written.join(", ")}.`
            : linked.length > 0
              ? "None of the files it connects to is written yet."
              : "",
          card.kind === "file"
            ? `Write ${own} now with at most 2 reads, then call finish_card.`
            : "Make the edits now with at most 2 reads, then call finish_card.",
        ]
          .filter(Boolean)
          .join(" ")
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What commands run in on this computer, so QA writes ones that work. */
export function shellNote(platform: string = process.platform): string {
  return platform === "win32"
    ? "Commands run in Windows PowerShell 5.1 on Windows: there is no && (join commands with ;), no grep (use Select-String), no head or cat -n. Prefer checking things for real over only reading, for example node --check file.js for a syntax check, or listing files with Get-ChildItem."
    : "Commands run in sh on this computer. Prefer checking things for real over only reading, for example node --check file.js for a syntax check, or listing files with ls.";
}

/** What was said on the cards next to this one: a file's connections, or the files a connection links. */
function aroundCard(project: CodingProject, card: CodingCard): string {
  const related =
    card.kind === "file"
      ? [...connectorCards(project, card), ...linkedFileCards(project, card)]
      : (project.edges.find((edge) => edge.id === card.ref)?.files ?? []).flatMap(
          (id) => project.cards.find((candidate) => candidate.ref === id && candidate.kind === "file") ?? [],
        );
  const lines = related.flatMap((other) =>
    other.comments
      .slice(-3)
      .map(
        (comment) =>
          `- ${other.title}: ${COMMENT_LABEL[comment.author]} (round ${comment.round}): ${comment.text}`,
      ),
  );
  return lines.length > 0 ? `What was said about the files around this card:${BSN}${lines.join(BSN)}` : "";
}

/** The cards of the files a file card is connected to. */
const linkedFileCards = (project: CodingProject, card: CodingCard) => {
  const others = new Set(
    project.edges
      .filter((edge) => edge.files.includes(card.ref))
      .flatMap((edge) => edge.files)
      .filter((id) => id !== card.ref),
  );
  return project.cards.filter((candidate) => candidate.kind === "file" && others.has(candidate.ref));
};

const connectorCards = (project: CodingProject, card: CodingCard) => {
  const edges = new Set(project.edges.filter((edge) => edge.files.includes(card.ref)).map((edge) => edge.id));
  return project.cards.filter((candidate) => candidate.kind === "connector" && edges.has(candidate.ref));
};

/** QA's job for one card, with the Developer's note and every comment on it and on the cards around it. */
export function qaMessage(
  project: CodingProject,
  card: CodingCard,
  retry = false,
  platform: string = process.platform,
  /** The exact names read from the code of the files around this one (see coding-contract.ts). */
  contract?: string | null,
  /** What changed in the file since QA last reviewed it (see coding-changes.ts). */
  changes?: string | null,
): string {
  const history = cardNotes(card, "Notes on this card so far:");
  const what =
    card.kind === "file"
      ? "Check that the file exists and its code does what the purpose says: complete (no unfinished parts, stubs or TODOs; a clearly marked placeholder for a secret only the user can supply is not one of those), no obvious errors. Read it with read_file. Check its connections too (listed above): what it uses from the other files and what they use from it must exist there with the same names (element ids, classes, functions, exports, data fields); read those files for that. You are the one who runs the code: install what it needs and run it or its tests with run_command (a command may need the user's approval first) when that is how to know it works."
      : "Check that the files really connect the way the connection says: read the files and make sure what one needs from the other is there and fits (names, arguments, imports). Run the project or a test with run_command (it may need the user's approval first) when that is how to know the connection works.";
  return [
    `Project brief: ${project.brief}`,
    `Output folder (your working folder): ${project.outputFolder}`,
    focusedOverview(project, card),
    `CARD TO REVIEW (${position(project, card)}, QA round ${project.round + 1}):${BSN}${cardSpec(project, card)}`,
    contract ?? "",
    history,
    changes ?? "",
    aroundCard(project, card),
    what,
    shellNote(platform),
    "A clearly marked placeholder (such as YOUR_API_KEY_HERE) for a secret only the user can provide is correct: accept it and never ask for a real key. Fail a file that holds what looks like a real secret someone made up.",
    "Then call review_card: verdict pass if it is right, or fail with a comment saying exactly what is wrong and how to fix it.",
    retry ? "Your last try ended without calling review_card. Call it now." : "",
  ]
    .filter(Boolean)
    .join(BSN + BSN);
}

/** Heading of the project-level check, which the tests (and the model) can recognise. */
export const FINAL_CHECK_HEADING = "FINAL CHECK OF THE WHOLE PROJECT";

/** QA's one project-level job once every card has passed and the automatic checks found nothing. */
export function finalCheckMessage(
  project: CodingProject,
  report: string,
  retry = false,
  platform: string = process.platform,
): string {
  const path = (id: string) => project.nodes.find((node) => node.id === id)?.path ?? id;
  return [
    `${FINAL_CHECK_HEADING}`,
    `Project brief: ${project.brief}`,
    `Output folder (your working folder): ${project.outputFolder}`,
    overview(project),
    `The connections:${BSN}${project.edges.map((edge) => `- ${edge.description} (${edge.files.map(path).join(", ")})`).join(BSN) || "(none)"}`,
    `The automatic checks: ${report}`,
    "Every card has passed on its own, but each was looked at alone. Now look at the project as a whole: read the files that matter (the entry point first) and look for anything that would stop it working when it is opened or run, especially problems that span files (a page that loads a script the wrong way, a name one file uses that another doesn't provide, a missing file, a setting the code needs that was left empty, though a clearly marked placeholder for a secret only the user can supply is fine). Run something for real where that helps.",
    shellNote(platform),
    "A clearly marked placeholder (such as YOUR_API_KEY_HERE) for a secret only the user can provide is correct: accept it and never ask for a real key.",
    "Then call finish_check: ok true if the project would work, or ok false with each problem as a planned file path and a comment saying exactly what is wrong and how to fix it.",
    retry ? "Your last try ended without calling finish_check. Call it now." : "",
  ]
    .filter(Boolean)
    .join(BSN + BSN);
}
