/**
 * Coding Bot eval against real local models: a small three-file project is planned, written and checked by the
 * Planner, Developer and QA roles, each on the model you name. Usage:
 *   pnpm --filter @mrog/harness exec tsx evals/coding.eval.ts qwen3.5:9b
 *   pnpm --filter @mrog/harness exec tsx evals/coding.eval.ts qwen3.5:9b planner=qwen3.5:9b developer=qwen3-coder:30b qa=qwen3.5:9b
 * The first bare argument is the model every role uses unless a role=model argument names another. EVAL_OLLAMA_URL
 * points the run at an Ollama on another address; EVAL_MAX_ROUNDS (default 3) is the QA round limit. Commands are
 * refused ("never allow"), so QA reads the code instead of running it. Prints, per role, the turns it took and what it
 * did, then the board, the files and PASS or FAIL: the project is done and every planned file exists and isn't empty.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODING_ROLES,
  DEFAULT_RUNTIME_SETTINGS,
  isCodingBusy,
  messageText,
  type CodingProject,
} from "@mrog/shared";
import { openStore } from "@mrog/store";
import { MemoryBackend, Vault } from "@mrog/vault";

import { buildServer, createServices, EventBus, settingsNameIndex } from "../src/index";

const BRIEF =
  process.env.EVAL_BRIEF ??
  "Build a tiny command-line tool in plain JavaScript (Node, no dependencies): `node src/main.js 3 4` prints the sum of its two number arguments, and an error message if an argument isn't a number. Keep the maths in its own file src/math.js (export add), the argument checking in src/args.js (export parseNumbers), and src/main.js ties them together. A README.md is not needed. Exactly three files.";
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
  services.agent.approvals.savePermissions({ localExecution: "never", rules: [] });
  const app = await buildServer(services);

  const model = (role: string) => (perRole[role] ? { model: `ollama:${perRole[role]}` } : {});
  const { bot, project } = await services.coding.create({
    name: "Eval Team",
    outputFolder: outDir,
    roles: { planner: model("planner"), developer: model("developer"), qa: model("qa") },
    autoApprove: true,
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
  const pass =
    final.status === "done" && files.length > 0 && files.every((file) => file.exists && file.bytes > 0);
  console.log(
    `\n=== ${pass ? "PASS" : "FAIL"} in ${Math.round((Date.now() - started) / 1000)}s: ${final.status}, ${final.round} round(s) ===`,
  );
  if (final.error) console.log(`error: ${final.error}`);
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
    console.log(`  [${card.column}] ${card.title}`);
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
  console.log("chat with the Coding Bot:");
  for (const message of store.messages.list(bot.threadId))
    if (message.role === "bot") console.log(`  ${messageText(message).replace(/\s+/g, " ").slice(0, 160)}`);

  await app.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
}

await run();
process.exit(0);
