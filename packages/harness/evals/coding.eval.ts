/**
 * Coding Bot eval against real local models: a small three-file project is planned, written and checked by the
 * Planner, Developer and QA roles, each on the model you name. Usage:
 *   pnpm --filter @mrog/harness exec tsx evals/coding.eval.ts qwen3.5:9b
 *   pnpm --filter @mrog/harness exec tsx evals/coding.eval.ts qwen3.5:9b planner=qwen3.5:9b developer=qwen3-coder:30b qa=qwen3.5:9b
 * The first bare argument is the model every role uses unless a role=model argument names another. EVAL_OLLAMA_URL
 * points the run at an Ollama on another address; EVAL_MAX_ROUNDS (default 3) is the QA round limit.
 *   EVAL_PROJECT=cli (default) is a three-file Node tool; EVAL_PROJECT=web is the four-page website brief that made a
 *   9B Developer loop on its CSS cards; EVAL_BRIEF replaces either with your own words.
 *   EVAL_PROJECT=todo is a one-page to-do list (HTML, CSS, JS), the kind of app Visual QA is for.
 *   EVAL_VISUAL=1 turns Visual QA on: QA opens the finished app in a hidden browser and uses it.
 *   EVAL_COMMANDS=never (default) refuses commands, so QA reads the code; EVAL_COMMANDS=allow answers every command card
 *   "allow once", as a user would, so QA really runs things (in a throwaway folder).
 * Prints, per role, the turns it took and what it did, then the board with each card's time, tokens and turns, the
 * retries, the files, the whole-project check, and PASS or FAIL: the project is done, every planned file exists and
 * isn't empty, and the automatic whole-project check finds nothing.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODING_ROLES,
  DEFAULT_BROWSER_SETTINGS,
  DEFAULT_RUNTIME_SETTINGS,
  isCodingBusy,
  messageText,
  type CodingProject,
} from "@mrog/shared";
import { openStore } from "@mrog/store";
import { MemoryBackend, Vault } from "@mrog/vault";

import { checkProject } from "../src/coding-check";
import { buildServer, createServices, EventBus, settingsNameIndex } from "../src/index";

const PROJECTS: Record<string, string> = {
  cli: "Build a tiny command-line tool in plain JavaScript (Node, no dependencies): `node src/main.js 3 4` prints the sum of its two number arguments, and an error message if an argument isn't a number. Keep the maths in its own file src/math.js (export add), the argument checking in src/args.js (export parseNumbers), and src/main.js ties them together. A README.md is not needed. Exactly three files.",
  web: "create a static 4 page gaming website for me. it should look professional and modern. create a proper website plan and website pages.",
  todo: "Build a small to-do list web page in plain HTML, CSS and JavaScript (no frameworks, no build step), with exactly three files: index.html, style.css and app.js. You type a task and click Add to put it in the list; clicking a task's Done button marks it done (struck through); its Delete button removes it.",
};
const VISUAL = process.env.EVAL_VISUAL === "1";
const BRIEF = process.env.EVAL_BRIEF ?? PROJECTS[process.env.EVAL_PROJECT ?? "cli"] ?? PROJECTS.cli!;
const COMMANDS = process.env.EVAL_COMMANDS === "allow" ? "allow" : "never";
const MAX_ROUNDS = Number(process.env.EVAL_MAX_ROUNDS ?? 3);
const TIME_LIMIT_MS = Number(process.env.EVAL_TIME_LIMIT_MS ?? 30 * 60_000);

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const perRole = Object.fromEntries(
  args.flatMap((arg) => {
    const [role, model] = arg.split("=");
    return model && (CODING_ROLES as readonly string[]).includes(role!) ? [[role, model]] : [];
  }),
);
const shared = args.find((arg) => !arg.includes("="));
if (!shared && Object.keys(perRole).length < 3) {
  console.error("Name a model: coding.eval.ts qwen3.5:9b");
  process.exit(1);
}

async function run() {
  const dataDir = mkdtempSync(join(tmpdir(), "mrog-codeeval-data-"));
  const outDir = mkdtempSync(join(tmpdir(), "mrog-codeeval-out-"));
  const store = openStore(":memory:");
  const bus = new EventBus();
  const vault = new Vault(new MemoryBackend(), settingsNameIndex(store.settings));
  const services = createServices({
    config: {
      host: "127.0.0.1",
      port: 0,
      token: "eval",
      dataDir,
      uiOrigins: [],
      uiDist: null,
      heartbeatMs: 60_000,
      vault: "memory",
      keyringService: "eval",
      previousKeyringService: null,
      eventLog: false,
    },
    store,
    vault,
    bus,
  });
  store.settings.set("runtime", {
    ...DEFAULT_RUNTIME_SETTINGS,
    sharedModel: shared ? `ollama:${shared}` : null,
    ...(process.env.EVAL_OLLAMA_URL ? { ollamaUrl: process.env.EVAL_OLLAMA_URL } : {}),
    numCtx: 16_384,
  });
  // "allow" still shows every card (the team's commands always ask): the run answers them below, as a user would.
  services.agent.approvals.savePermissions({
    localExecution: COMMANDS === "allow" ? "ask" : "never",
    rules: [],
  });
  const app = await buildServer(services);
  // Visual QA's browser runs hidden, in one shared profile, like the tests.
  if (VISUAL) store.settings.set("browser", { ...DEFAULT_BROWSER_SETTINGS, show: false, profiles: "shared" });

  const model = (role: string) => (perRole[role] ? { model: `ollama:${perRole[role]}` } : {});
  const { bot, project } = await services.coding.create({
    name: "Eval Team",
    outputFolder: outDir,
    roles: { planner: model("planner"), developer: model("developer"), qa: model("qa") },
    autoApprove: true,
    visualQa: VISUAL,
    maxRounds: MAX_ROUNDS,
  });

  // Per role: how many turns it took and how its tools went.
  const turns = Object.fromEntries(CODING_ROLES.map((role) => [role, { turns: 0, tools: [] as string[] }]));
  const roleOf = new Map(CODING_ROLES.map((role) => [project.roles[role].botId, role]));
  const seen = new Set<string>();
  bus.subscribe((event) => {
    if (event.type !== "message.updated" || !roleOf.has(event.message.botId ?? "")) return;
    const stats = turns[roleOf.get(event.message.botId!)!]!;
    if (!seen.has(event.message.id)) {
      seen.add(event.message.id);
      stats.turns += 1;
    }
    if (event.message.status !== "streaming")
      for (const part of event.message.parts)
        if (part.type === "tool" && !stats.tools.includes(`${event.message.id}:${part.callId}`))
          stats.tools.push(`${event.message.id}:${part.callId}:${part.name}:${part.status}`);
  });

  const answered = new Set<string>();
  let commands = 0;
  if (COMMANDS === "allow")
    bus.subscribe((event) => {
      if (event.type !== "message.updated" || event.message.threadId !== bot.threadId) return;
      for (const part of event.message.parts)
        if (
          part.type === "tool" &&
          part.status === "pending_approval" &&
          part.approval &&
          !answered.has(part.approval.id)
        ) {
          answered.add(part.approval.id);
          commands += 1;
          void app.inject({
            method: "POST",
            url: `/api/approvals/${part.approval.id}`,
            headers: { authorization: "Bearer eval" },
            payload: { decision: "allow_once" },
          });
        }
    });

  const started = Date.now();
  await services.turns.send(store.threads.get(bot.threadId)!, { text: BRIEF });
  let final: CodingProject = project;
  while (Date.now() - started < TIME_LIMIT_MS) {
    final = services.coding.get(bot.id)!;
    if (!isCodingBusy(final.status) && final.status !== "setup") break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (isCodingBusy(final.status)) await services.coding.stop(bot.id);
  final = services.coding.get(bot.id)!;

  const files = final.nodes.map((node) => {
    const path = join(outDir, node.path);
    return { path: node.path, exists: existsSync(path), bytes: existsSync(path) ? statSync(path).size : 0 };
  });
  const read = (path: string) => {
    const full = join(outDir, path);
    return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : null;
  };
  const findings = checkProject({ files: final.nodes.map((node) => node.path), read });
  const retries = (final.log ?? []).filter((line) => /again|didn't finish|failed/i.test(line.text)).length;
  const pass =
    final.status === "done" &&
    files.length > 0 &&
    files.every((file) => file.exists && file.bytes > 0) &&
    findings.length === 0;
  console.log(
    `\n=== ${pass ? "PASS" : "FAIL"} in ${Math.round((Date.now() - started) / 1000)}s: ${final.status}, ${final.round} round(s) ===`,
  );
  if (final.error) console.log(`error: ${final.error}`);
  console.log(
    `commands: ${COMMANDS}${COMMANDS === "allow" ? ` (${commands} approved)` : ""}; retries and failures in the log: ${retries}`,
  );
  console.log(
    `whole-project check: ${findings.length === 0 ? "nothing found" : `${findings.length} finding(s)`}`,
  );
  for (const finding of findings) console.log(`  ${finding.file}: ${finding.problem}`);
  for (const role of CODING_ROLES) {
    const calls = turns[role]!.tools.map((entry) => entry.split(":").slice(2).join(":"));
    const failed = calls.filter((call) => !call.endsWith(":done")).length;
    console.log(
      `${role.padEnd(9)} model ${project.roles[role].model ?? shared}: ${turns[role]!.turns} turn(s), ${calls.length} tool call(s), ${failed} not done`,
    );
  }
  console.log(`plan: ${final.nodes.length} files, ${final.edges.length} connections`);
  for (const node of final.nodes) console.log(`  ${node.path}: ${node.purpose}`);
  for (const edge of final.edges)
    console.log(
      `  connection ${edge.id}: ${edge.description} (${edge.files.map((id) => final.nodes.find((n) => n.id === id)?.path).join(", ")})`,
    );
  console.log("board:");
  for (const card of final.cards) {
    const work = card.work;
    console.log(
      `  [${card.column}] ${card.title}${work ? ` (${Math.round(work.seconds)} s, ${work.inputTokens} in, ${work.outputTokens} out, ${work.turns} turn(s))` : ""}`,
    );
    for (const comment of card.comments)
      console.log(
        `      ${comment.author} (round ${comment.round}): ${comment.text.replace(/\s+/g, " ").slice(0, 160)}`,
      );
  }
  console.log("files:");
  for (const file of files) console.log(`  ${file.path}: ${file.exists ? `${file.bytes} bytes` : "MISSING"}`);
  if (files[0]?.exists)
    console.log(`first file:\n${readFileSync(join(outDir, files[0].path), "utf8").slice(0, 600)}`);
  console.log("activity:");
  for (const line of final.log ?? []) console.log(`  ${line.text}`);
  if (VISUAL) {
    console.log("Visual QA turns (QA's tool calls, in order):");
    const qa = store.bots.get(project.roles.qa.botId)!;
    for (const thread of store.threads.list())
      for (const message of store.messages.list(thread.id))
        if (
          message.botId === qa.id &&
          message.parts.some(
            (part) => part.type === "tool" && /^(app_|screen_|finish_visual)/.test(part.name),
          )
        )
          for (const part of message.parts)
            if (part.type === "tool")
              console.log(
                `  ${part.name}(${JSON.stringify(part.args).slice(0, 80)}) → ${part.status}: ${(part.result ?? "").replace(/\s+/g, " ").slice(0, 140)}`,
              );
  }
  console.log("chat with the Coding Bot:");
  for (const message of store.messages.list(bot.threadId))
    if (message.role === "bot") console.log(`  ${messageText(message).replace(/\s+/g, " ").slice(0, 160)}`);

  await services.browser.close();
  await app.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
}

await run();
process.exit(0);
