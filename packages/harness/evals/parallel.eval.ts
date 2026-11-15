/**
 * Parallel Bots against real local models: each question goes out as ONE request and must come back as one reply
 * with three sections, each from a different role, each with an answer of its own. Usage:
 *   pnpm --filter @mrog/harness exec tsx evals/parallel.eval.ts qwen3.5:9b [more models]
 * Name several models to compare them (try a 9B against a 14B or 30B). Needs Ollama with the models pulled.
 *   EVAL_OLLAMA_URL  an Ollama on another address
 *   EVAL_QUESTIONS   how many of the questions to ask (default all)
 *   EVAL_NUM_CTX     context size (default 32768)
 *   EVAL_TOOLS=1     the Allow tools variant: each role runs on its own with web_search and fetch_url (needs the
 *                    browser set up, or a search API in Settings → Browser). Checks that all three roles answer,
 *                    that they searched, that nothing failed, and that no role cites an address only another role
 *                    opened. EVAL_STEPS (default 6) and EVAL_LANES (default 3) set the steps per role and the roles
 *                    writing at once.
 * Writes every reply to evals/results/parallel-<time>.md so you can read what the models wrote.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_RUNTIME_SETTINGS,
  groupByLane,
  messageText,
  parseParallel,
  type Message,
} from "@mrog/shared";
import { openStore } from "@mrog/store";
import { MemoryBackend, Vault } from "@mrog/vault";

import { buildServer, createServices, EventBus, settingsNameIndex } from "../src/index";

const QUESTIONS = [
  "Should a 20-person company move its servers from AWS to its own hardware?",
  "I'm opening a small bakery in a town of 15,000 people. How do I get my first 100 customers?",
  "Our team keeps missing deadlines on a software project. What should we change?",
  "Is it better to learn Python or JavaScript first if I want a job in two years?",
  "How should a city reduce traffic in its centre without hurting the shops there?",
  "Write the opening of a short story about a lighthouse keeper who finds a message in a bottle.",
];

/** Questions that need facts from the web, for the Allow tools variant. */
const TOOL_QUESTIONS = [
  "What changed in the latest stable release of Node.js, and is it worth upgrading from the previous LTS?",
  "Which three public transport options are best for a day trip from Berlin to Dresden, and what do they cost?",
  "What do recent studies say about whether a four-day work week raises productivity?",
];
const WITH_TOOLS = process.env.EVAL_TOOLS === "1";

/** What one lane did, for the report and the checks. */
function laneReport(message: Message, question: string) {
  const urls = (text: string) =>
    text.match(/https?:\/\/[^\s)>\]"']+/g)?.map((u) => u.replace(/[.,;:]+$/, "")) ?? [];
  const { lanes } = groupByLane(message.parts);
  return lanes.map((parts, i) => {
    const head = parts.find((p) => p.type === "text");
    const tools = parts.filter((p) => p.type === "tool");
    const own = new Set([
      ...urls(question),
      ...tools.flatMap((p) => (p.type === "tool" ? urls(`${JSON.stringify(p.args)} ${p.result ?? ""}`) : [])),
    ]);
    const answer = parts
      .filter((p) => p.type === "text" && p !== head)
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim();
    return {
      lane: i + 1,
      role: head?.type === "text" ? (head.text.split("\n")[0] ?? "").replace(/^## \d\. /, "") : "?",
      tools: tools.map((p) => (p.type === "tool" ? `${p.name}:${p.status}` : "")),
      errors: parts.filter((p) => p.type === "error").map((p) => (p.type === "error" ? p.message : "")),
      answer,
      foreign: urls(answer).filter((u) => !own.has(u)),
    };
  });
}

const TEMPLATE_ECHO = /<role name>|<answer of/i;

interface Row {
  question: string;
  seconds: number;
  roles: string[];
  ok: boolean;
  problem: string;
  tokens: number | null;
  raw: string;
}

async function run(model: string, questions: string[]): Promise<Row[]> {
  const dataDir = mkdtempSync(join(tmpdir(), "mrog-pareval-"));
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
    sharedModel: `ollama:${model}`,
    numCtx: Number(process.env.EVAL_NUM_CTX ?? 32768),
    ...(process.env.EVAL_OLLAMA_URL ? { ollamaUrl: process.env.EVAL_OLLAMA_URL } : {}),
    parallelSteps: Number(process.env.EVAL_STEPS ?? 6),
    parallelLanes: Number(process.env.EVAL_LANES ?? 3),
  });
  const app = await buildServer(services);
  const bot = store.bots.create({ name: "Ada", isPrimary: true });
  const thread = store.threads.get(bot.threadId)!;

  const rows: Row[] = [];
  for (const question of questions) {
    // A fresh chat for each question, so one answer can't shape the next.
    store.messages.clear(thread.id);
    const started = Date.now();
    const done = new Promise<Message>((resolve) => {
      const off = bus.subscribe((event) => {
        if (
          event.type === "message.updated" &&
          event.message.botId === bot.id &&
          event.message.threadId === thread.id &&
          event.message.status !== "streaming"
        ) {
          off();
          resolve(event.message);
        }
      });
    });
    const timeout = setTimeout(() => services.turns.stop(thread.id), 300_000);
    await services.turns.send(thread, {
      text: question,
      parallel: true,
      ...(WITH_TOOLS ? { parallelTools: true } : {}),
    });
    const reply = await done;
    clearTimeout(timeout);

    const laneInfo = WITH_TOOLS ? laneReport(reply, question) : [];
    const raw = WITH_TOOLS
      ? laneInfo
          .map(
            (l) =>
              `## ${l.lane}. ${l.role}  [${l.tools.join(", ") || "no tools"}]${l.errors.length ? `  ERRORS: ${l.errors.join("; ")}` : ""}\n${l.answer}`,
          )
          .join("\n\n")
      : messageText(reply);
    const { sections } = WITH_TOOLS
      ? { sections: laneInfo.map((l) => ({ role: l.role, text: l.answer })) }
      : parseParallel(raw);
    const roles = sections.map((section) => section.role);
    let problem = "";
    if (WITH_TOOLS) {
      if (reply.status !== "done") problem = `reply ${reply.status}`;
      else if (!reply.parallelTools) problem = "reply not marked as Allow tools";
      else if (laneInfo.some((l) => l.errors.length > 0)) problem = "a role failed";
      else if (laneInfo.some((l) => l.answer.length < 40)) problem = "a role has almost no answer";
      else if (laneInfo.every((l) => l.tools.length === 0)) problem = "no role searched";
      else if (laneInfo.some((l) => l.foreign.length > 0))
        problem = `a role cites an address only another role opened: ${laneInfo.flatMap((l) => l.foreign)[0]}`;
      else if (new Set(roles.map((role) => role.toLowerCase())).size < 3)
        problem = "roles are not three different ones";
    } else if (reply.status !== "done") problem = `reply ${reply.status}`;
    else if (!reply.parallel) problem = "reply not marked parallel";
    else if (sections.length < 3) problem = `${sections.length} of 3 sections`;
    else if (sections.some((section) => section.text.length < 40)) problem = "a section has almost no answer";
    else if (new Set(roles.map((role) => role.toLowerCase())).size < 3)
      problem = "roles are not three different ones";
    else if (TEMPLATE_ECHO.test(raw)) problem = "copied the form's placeholders";
    rows.push({
      question,
      seconds: Math.round((Date.now() - started) / 1000),
      roles,
      ok: problem === "",
      problem,
      tokens: reply.usage?.outputTokens ?? null,
      raw,
    });
    console.log(
      `${problem === "" ? "ok  " : "FAIL"} ${String(rows.at(-1)!.seconds).padStart(3)}s  ${roles.join(" | ") || "(no sections)"}${problem ? `  <- ${problem}` : ""}`,
    );
  }

  await app.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  return rows;
}

const models = process.argv.slice(2).filter((arg) => arg !== "--");
if (models.length === 0) {
  console.error("Usage: tsx evals/parallel.eval.ts <model> [<model>…]");
  process.exit(2);
}
const pool = WITH_TOOLS ? TOOL_QUESTIONS : QUESTIONS;
const questions = pool.slice(0, Number(process.env.EVAL_QUESTIONS ?? pool.length));
const report: string[] = [
  `# Parallel Bots eval${WITH_TOOLS ? " (Allow tools)" : ""}, ${new Date().toISOString()}`,
  "",
];
for (const model of models) {
  console.log(`\n=== ${model} ===`);
  const rows = await run(model, questions);
  const passed = rows.filter((row) => row.ok).length;
  const seconds = rows.reduce((sum, row) => sum + row.seconds, 0);
  console.log(
    `--- ${model}: ${passed}/${rows.length} came back as three good sections, ${Math.round(seconds / rows.length)}s each on average`,
  );
  report.push(`## ${model}: ${passed}/${rows.length}`, "");
  for (const row of rows) {
    report.push(
      `### ${row.ok ? "ok" : `FAIL (${row.problem})`}: ${row.question}`,
      `${row.seconds}s, ${row.tokens ?? "?"} tokens`,
      "",
      "```",
      row.raw,
      "```",
      "",
    );
  }
}
const dir = join(import.meta.dirname, "results");
mkdirSync(dir, { recursive: true });
const file = join(dir, `parallel-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`);
writeFileSync(file, report.join("\n"));
console.log(`\nReport: ${file}`);
process.exit(0);
