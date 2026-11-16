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

import { validatePlan } from "./coding-plan";

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
  plan?: Extract<ReturnType<typeof validatePlan>, { ok: true }>;
  /** What was wrong with the last plan the tool turned down, for the retry. */
  rejected?: string[];
  finished?: { note: string };
  review?: { pass: boolean; comment: string };
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
      return `Plan accepted: ${result.nodes.length} files, ${result.edges.length} connections. Reply with one short sentence and stop; don't write the plan out again.`;
    },
  });

/** `finish_card`: the Developer says the card is ready for QA. A file that isn't there yet is not ready. */
export const finishCardTool = (capture: TurnCapture): ToolSpec =>
  defineTool({
    name: "finish_card",
    description:
      "Say that your card is finished and ready for QA, with a one-sentence note on what you did. Call it when the work is done, not before.",
    args: z.object({ note: z.string().trim().max(1000).optional() }),
    risk: () => safe("Hand the card to QA"),
    run: async (args, ctx) => {
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
      },
      required: ["verdict"],
    },
    // Models send the verdict under other names, and as a boolean.
    prepare: (args) => {
      const verdict = args.verdict ?? args.result ?? args.status ?? args.passed ?? args.pass;
      return {
        verdict: typeof verdict === "boolean" ? (verdict ? "pass" : "fail") : verdict,
        comment: args.comment ?? args.reason ?? args.feedback ?? args.notes ?? args.note,
      };
    },
    args: z.object({
      verdict: z.string().refine((value) => PASS.test(value.trim()) || FAIL.test(value.trim()), {
        message: 'must be "pass" or "fail"',
      }),
      comment: z.string().trim().max(4000).optional(),
    }),
    risk: () => safe("Review the card"),
    run: async (args) => {
      const pass = PASS.test(args.verdict.trim());
      const comment = args.comment ?? "";
      if (!pass && !comment)
        return "A fail needs a comment: say exactly what is wrong and how to fix it. Call review_card again with verdict fail and a comment.";
      capture.review = { pass, comment };
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
  return `${common} You are QA: you get one card at a time and review it. You run and test the code: read it with read_file, install the packages it needs and run the project or its tests with run_command (each command asks the user first), then call review_card with pass or fail. You don't change files. A clearly marked placeholder (YOUR_API_KEY_HERE) for a secret only the user can provide is correct: accept it and never ask for a real key. Fail a file that contains what looks like a real secret someone made up. A fail needs a comment saying exactly what is wrong and how to fix it, because the Developer sees nothing else.`;
}

const COMMENT_LABEL: Record<CardComment["author"], string> = {
  planner: "Planner",
  developer: "Developer",
  qa: "QA",
  user: "You",
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
  extra: { problems?: string[]; revision?: string; built?: boolean } = {},
): string {
  const parts = [
    `The user's brief:\n${project.brief}`,
    `Plan the project. List every file it needs (a path relative to ${project.outputFolder}, with forward slashes, and what the code in that file should do) in the order they should be built, files others use first. Then list the connections: each links two or more of those files and says what connects them (a function one calls from the other, a type they share, a file both read). At most ${MAX_PLAN_FILES} files. Plan only what the brief needs.`,
    "Send it by calling propose_plan. If you can't call tools, reply with the plan as one JSON code block like this and nothing else:",
    FORMAT_EXAMPLE,
  ];
  if (project.nodes.length > 0 && extra.revision) {
    const current = {
      nodes: project.nodes.map(({ path, purpose }) => ({ path, purpose })),
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
      extra.built
        ? `The user now asks for a change:\n${extra.revision}\nSend the whole updated plan, not only the changes.${keep}`
        : `The user looked at it and asks for changes:\n${extra.revision}\nSend the whole updated plan, not only the changes.${keep}`,
    );
  } else if (extra.revision) parts.push(`The user asks for:\n${extra.revision}`);
  if (extra.problems?.length)
    parts.push(
      `Your last plan was not accepted:\n${extra.problems.map((problem) => `- ${problem}`).join("\n")}\nSend the corrected whole plan.`,
    );
  return parts.join("\n\n");
}

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
}

const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

function lastTryLine(card: CodingCard, own: string, last: LastTry): string {
  const what = last.error
    ? `stopped with an error (${last.error})`
    : last.wrote
      ? `${card.kind === "file" ? `wrote ${own}` : "changed the files"}, but finish_card was not called`
      : `read ${files(last.reads)} and wrote nothing`;
  return `Your last try ${what}${last.stepLimit && !last.error ? ", and it hit the step limit" : ""}.`;
}

/** The Developer's job for one card. It carries everything needed: the Developer reads no earlier chat. */
export function developerMessage(
  project: CodingProject,
  card: CodingCard,
  last?: LastTry | null,
  written: (path: string) => boolean = writtenIn(project.outputFolder),
): string {
  const history = card.comments.length > 0 ? `Earlier notes on this card:\n${notes(card.comments)}` : "";
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
    overview(project),
    `YOUR CARD (${position(project, card)}, round ${project.round + 1}):\n${cardSpec(project, card)}`,
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
      ? connectorCards(project, card)
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
): string {
  const history = card.comments.length > 0 ? `Notes on this card so far:${BSN}${notes(card.comments)}` : "";
  const what =
    card.kind === "file"
      ? "Check that the file exists and its code does what the purpose says: complete (no unfinished parts, stubs or TODOs; a clearly marked placeholder for a secret only the user can supply is not one of those), no obvious errors. Read it with read_file. You are the one who runs the code: install what it needs and run it or its tests with run_command (each command asks the user first) when that is how to know it works."
      : "Check that the files really connect the way the connection says: read the files and make sure what one needs from the other is there and fits (names, arguments, imports). Run the project or a test with run_command (it asks the user first) when that is how to know the connection works.";
  return [
    `Project brief: ${project.brief}`,
    `Output folder (your working folder): ${project.outputFolder}`,
    overview(project),
    `CARD TO REVIEW (${position(project, card)}, QA round ${project.round + 1}):${BSN}${cardSpec(project, card)}`,
    history,
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
