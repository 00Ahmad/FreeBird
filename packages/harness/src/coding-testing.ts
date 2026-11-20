import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Bot, CodingProject } from "@mrog/shared";
import { openStore, type Store } from "@mrog/store";
import { MemoryBackend, Vault } from "@mrog/vault";
import { DEFAULT_RUNTIME_SETTINGS } from "@mrog/shared";

import { EventBus } from "./bus";
import { settingsNameIndex } from "./index";
import { buildServer } from "./server";
import { createServices } from "./services";
import { auth, fakeFetch, fakeOllama, ndjson, type TestHarness } from "./testing";

/** Helpers for the Coding Bot tests: a scripted team behind the fake Ollama, temp folders and a way to wait. */

export type Role = "planner" | "developer" | "qa";

export interface Seen {
  role: Role | "other";
  /** The first request of a turn (a turn makes one more for each tool result). */
  fresh: boolean;
  /** The one project-level QA turn after every card passed (not a card review). */
  finalCheck: boolean;
  /** QA's Visual QA turn, after the check of the whole project. */
  visual: boolean;
  model: string;
  task: string;
  /** How many messages the model was sent besides its system prompt. */
  messages: number;
  tools: string[];
  /** The `think` the model was sent, if any. */
  think: unknown;
  /** The newest tool result in the conversation (what the model just learned). */
  lastTool: string;
  /** Notes added to the turn after its task (the Developer's "steps left" note). */
  notes: string[];
  system: string;
}

/** `fail`: the model fails (an HTTP 500) instead of answering; `wait`: it answers once this settles. */
export type PlanStep = ({ tool: unknown } | { json: unknown } | { say: string } | { fail: true }) & {
  wait?: Promise<void>;
};

export interface DevAct {
  /** File content to write (file cards); null writes nothing. */
  write?: string | null;
  /** A command the Developer tries to run (it has no such tool: the result says so). */
  command?: string;
  /** Another path to write before its own (a file that belongs to another card). */
  extra?: { path: string; content: string };
  /** More paths to write before its own, in order. */
  extras?: { path: string; content: string }[];
  /** Never finish: keep reading one more file, call after call. */
  loop?: boolean;
  /** Files to read (read_file) before anything else. */
  reads?: string[];
  /** The model fails (an HTTP 500) on this request of the turn (0 is the first), after the calls before it. */
  failAt?: number;
  /** Call finish_card (default yes). */
  finish?: boolean;
  /** How many times to call finish_card (default 1), as a small model may call it again and again. */
  finishTimes?: number;
  /** Wait for this before answering (a slow model). */
  wait?: Promise<void>;
}

export interface FinalVerdict {
  ok: boolean;
  problems?: { file: string; comment: string }[];
}

export interface Behave {
  /** QA's verdict on the whole project; `nth` counts the final checks so far. */
  finalCheck?(nth: number): FinalVerdict;
  /** QA's Visual QA: whether it calls app_start first (default yes), then its verdict. `nth` counts them. */
  visualCheck?(nth: number): FinalVerdict & { start?: boolean };
  /** Planner replies in order; the last one repeats. */
  plans: PlanStep[];
  develop(card: { kind: "file" | "connector"; key: string }, attempt: number): DevAct;
  /** QA's verdict on a card; `nth` counts the reviews of that card so far (1 for the first). */
  review(
    card: { kind: "file" | "connector"; key: string },
    nth: number,
  ): {
    pass: boolean;
    comment?: string;
    /** QA says the plan itself is the problem (review_card's plan_problem). */
    planProblem?: boolean;
    command?: string;
    wait?: Promise<void>;
    failAt?: number;
    /** Files QA reads (read_file) first. */
    reads?: string[];
    /** Text QA searches the folder for (search_files) first. */
    search?: string;
  };
}

export const THREE_FILES = {
  nodes: [
    { path: "src/util.ts", purpose: "helpers the other files use" },
    { path: "src/main.ts", purpose: "entry point that calls the helpers" },
  ],
  edges: [{ files: ["src/main.ts", "src/util.ts"], description: "main imports greet from util" }],
};

const call = (name: string, args: unknown) => [
  { message: { tool_calls: [{ function: { name, arguments: args } }] } },
];
const text = (words: string) => [{ message: { content: words } }];

/** A scripted team: each role answers from `behave`, whatever the other roles do. Every request is recorded. */
export function codingTeam(over: Partial<Behave> = {}, models?: string[]) {
  const behave: Behave = {
    plans: [{ tool: THREE_FILES }],
    develop: () => ({}),
    review: () => ({ pass: true }),
    ...over,
  };
  const seen: Seen[] = [];
  const planned = { n: 0 };
  const attempts = new Map<string, number>();
  const reviews = new Map<string, number>();
  let finalChecks = 0;
  let visualChecks = 0;
  const handlers = fakeOllama(async (body) => {
    const system: string = body.messages[0]?.content ?? "";
    const role = (/You are .+? (Planner|Developer|QA),/.exec(system)?.[1]?.toLowerCase() ??
      "other") as Seen["role"];
    const messages: { role: string; content: string }[] = body.messages;
    // A role's turn is its one task; a user message after it is a note added mid-turn, not a new task.
    const firstUser = messages.findIndex((m) => m.role === "user");
    const task = messages[firstUser]?.content ?? "";
    const done = messages.slice(firstUser + 1).filter((m) => m.role === "tool").length;
    seen.push({
      role,
      fresh: done === 0,
      finalCheck: task.includes("FINAL CHECK OF THE WHOLE PROJECT"),
      visual: task.includes("VISUAL QA OF THE WHOLE PROJECT"),
      model: body.model,
      task,
      messages: messages.length - 1,
      tools: (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
      think: body.think,
      lastTool: messages.findLast((m) => m.role === "tool")?.content ?? "",
      notes: messages.slice(firstUser + 1).flatMap((m) => (m.role === "user" ? [m.content] : [])),
      system,
    });
    if (role === "other") return ndjson([...text("hello"), { done: true }]);
    const kind = /^Connection: /m.test(task) ? "connector" : "file";
    const key = (kind === "file" ? /^File: (.+)$/m : /^Connection: (.+)$/m).exec(task)?.[1] ?? "?";
    const card = { kind, key } as const;
    let rows: unknown[];
    if (role === "planner") {
      const step = behave.plans[Math.min(done === 0 ? planned.n++ : planned.n - 1, behave.plans.length - 1)]!;
      if (done === 0 && step.wait) await step.wait;
      if ("fail" in step) return new Response("the model crashed", { status: 500 });
      rows =
        done > 0 || "say" in step
          ? text("say" in step ? step.say : "Plan sent.")
          : "json" in step
            ? text(`Here is the plan:\n\`\`\`json\n${JSON.stringify(step.json)}\n\`\`\``)
            : call("propose_plan", step.tool);
    } else if (role === "developer") {
      const attempt =
        done === 0
          ? (attempts.set(key, (attempts.get(key) ?? 0) + 1), attempts.get(key)!)
          : attempts.get(key)!;
      const act = behave.develop(card, attempt);
      if (act.failAt === done) return new Response("the model crashed", { status: 500 });
      const calls: [string, unknown][] = [];
      for (const path of act.reads ?? []) calls.push(["read_file", { path }]);
      if (act.extra) calls.push(["write_file", act.extra]);
      for (const extra of act.extras ?? []) calls.push(["write_file", extra]);
      if (act.command) calls.push(["run_command", { command: act.command }]);
      if (kind === "file" && act.write !== null)
        calls.push(["write_file", { path: key, content: act.write ?? `// ${key}\n` }]);
      if (act.finish !== false)
        for (let n = 0; n < (act.finishTimes ?? 1); n++) calls.push(["finish_card", { note: `Did ${key}` }]);
      if (done === 0 && act.wait) await act.wait;
      const next = act.loop
        ? (["read_file", { path: `notes/${done}.txt` }] as [string, unknown])
        : calls[done];
      rows = next ? call(next[0], next[1]) : text("Done.");
    } else if (task.includes("VISUAL QA OF THE WHOLE PROJECT")) {
      const nth = done === 0 ? ++visualChecks : visualChecks;
      const verdict = behave.visualCheck?.(nth) ?? { ok: true };
      const calls: [string, unknown][] = [
        ...(verdict.start === false ? [] : [["app_start", {}] as [string, unknown]]),
        ["finish_visual_check", { ok: verdict.ok, problems: verdict.problems }],
      ];
      const next = calls[done];
      rows = next ? call(next[0], next[1]) : text("Used the app.");
    } else if (task.includes("FINAL CHECK OF THE WHOLE PROJECT")) {
      const nth = done === 0 ? ++finalChecks : finalChecks;
      const verdict = behave.finalCheck?.(nth) ?? { ok: true };
      rows =
        done === 0 ? call("finish_check", { ok: verdict.ok, problems: verdict.problems }) : text("Checked.");
    } else {
      const nth =
        done === 0 ? (reviews.set(key, (reviews.get(key) ?? 0) + 1), reviews.get(key)!) : reviews.get(key)!;
      const verdict = behave.review(card, nth);
      if (verdict.failAt === done) return new Response("the model crashed", { status: 500 });
      if (done === 0 && verdict.wait) await verdict.wait;
      const calls: [string, unknown][] = [];
      for (const path of verdict.reads ?? []) calls.push(["read_file", { path }]);
      if (verdict.search) calls.push(["search_files", { query: verdict.search }]);
      if (verdict.command) calls.push(["run_command", { command: verdict.command }]);
      calls.push([
        "review_card",
        {
          verdict: verdict.pass ? "pass" : "fail",
          comment: verdict.comment ?? "",
          ...(verdict.planProblem ? { plan_problem: true } : {}),
        },
      ]);
      const next = calls[done];
      rows = next ? call(next[0], next[1]) : text("Reviewed.");
    }
    // Every request reports the tokens it used, so a card's totals can be checked.
    return ndjson([...rows, { done: true, prompt_eval_count: 100, eval_count: 10 }]);
  });
  if (models)
    handlers["/api/tags"] = () =>
      Response.json({
        models: models.map((name) => ({
          name,
          size: 1,
          capabilities: ["completion", "tools"],
          details: { context_length: 8192 },
        })),
      });
  return { handlers, seen, behave };
}

const cleanups: string[] = [];
export const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), `coding-${prefix}-`));
  cleanups.push(dir);
  return dir;
};
export const cleanTmp = () => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
};

/** Services over an existing store, as the app does at start: a second one over the same store is a restart. */
export async function boot(
  store: Store,
  handlers: ReturnType<typeof fakeOllama>,
  dataDir: string,
): Promise<TestHarness> {
  const bus = new EventBus();
  const vault = new Vault(new MemoryBackend(), settingsNameIndex(store.settings));
  const { impl, calls } = fakeFetch(handlers);
  const services = createServices({
    config: {
      host: "127.0.0.1",
      port: 0,
      token: "t".repeat(64),
      dataDir,
      uiOrigins: [],
      uiDist: null,
      heartbeatMs: 60_000,
      vault: "memory",
      keyringService: "test",
      previousKeyringService: null,
      eventLog: false,
    },
    store,
    vault,
    bus,
    fetchImpl: impl,
  });
  const app = await buildServer(services);
  return {
    app,
    store,
    bus,
    services,
    calls,
    async close() {
      await app.close();
    },
  };
}

export const freshStore = () => openStore(":memory:");

export function useSharedModel(h: TestHarness) {
  h.store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: "ollama:test:1b" });
}

export interface Made {
  bot: Bot;
  project: CodingProject;
}

/** Creates a Coding Bot through the API. */
export async function makeCoding(
  h: TestHarness,
  folder: string,
  over: Record<string, unknown> = {},
): Promise<Made> {
  useSharedModel(h);
  const res = await h.app.inject({
    method: "POST",
    url: "/api/coding-bots",
    headers: auth,
    payload: { name: "Alpha", outputFolder: folder, roles: { planner: {}, developer: {}, qa: {} }, ...over },
  });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
  return res.json() as Made;
}

/** The turns a role has had so far, as the task each was given. */
/** The project-level QA turns. */
export const finalChecksOf = (team: { seen: Seen[] }) =>
  team.seen.filter((s) => s.role === "qa" && s.fresh && s.finalCheck);

export const turnsOf = (team: { seen: Seen[] }, role: Role) =>
  team.seen.filter((s) => s.role === role && s.fresh && !s.finalCheck && !s.visual);

/** QA's Visual QA turns. */
export const visualChecksOf = (team: { seen: Seen[] }) =>
  team.seen.filter((s) => s.role === "qa" && s.fresh && s.visual);

export const getProject = (h: TestHarness, botId: string) => h.services.coding.get(botId)!;

/** Waits until the project satisfies `match` (polling, so a missed event can't hang a test). */
export async function until(
  h: TestHarness,
  botId: string,
  match: (project: CodingProject) => boolean,
  timeoutMs = 15_000,
): Promise<CodingProject> {
  const start = Date.now();
  for (;;) {
    const project = getProject(h, botId);
    if (match(project)) return project;
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `Timed out. Project is ${project.status}: ${JSON.stringify(project.cards.map((c) => [c.id, c.column]))} ${project.error ?? ""}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export const post = (h: TestHarness, url: string, payload?: Record<string, unknown>) =>
  h.app.inject({ method: "POST", url, headers: auth, ...(payload === undefined ? {} : { payload }) });

/** Types a message in a bot's own chat. */
export const type = (h: TestHarness, bot: Bot, textToSend: string) =>
  post(h, `/api/threads/${bot.threadId}/messages`, { text: textToSend });
