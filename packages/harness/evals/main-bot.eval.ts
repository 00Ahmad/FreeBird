/**
 * The main bot's eval against real local models: a message sent mid-turn, a follow-up, a job split between helpers.
 * Usage:
 *   pnpm --filter @mrog/harness exec tsx evals/main-bot.eval.ts qwen3.5:9b [--only=midturn,split] [--no-self-check]
 * Needs Ollama running with those models pulled. Commands stay refused; no web access is needed (helpers answer from
 * what they know). For each case it records whether it passed, the wall time, and what the model was asked: every
 * request, the helper planner's questions, the self-checks and their verdicts, and the "carry on" nudges. Results go
 * to evals/results/ as JSON.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_RUNTIME_SETTINGS, messageText, type Bot, type Message } from "@mrog/shared";
import { openStore } from "@mrog/store";
import { MemoryBackend, Vault } from "@mrog/vault";

import { buildServer, createServices, EventBus, settingsNameIndex, type Services } from "../src/index";

/** What the model was asked during a case, read from the requests sent to Ollama. */
interface Counts {
  requests: number;
  planner: number;
  selfChecks: number;
  /** Self-checks answered with something other than "OK": the answer changed. */
  selfCheckChanges: number;
  nudges: number;
}

interface Run {
  services: Services;
  bot: Bot;
  workspace: string;
  /** Sends a message and waits for the bot's reply to it. */
  say(text: string): Promise<Message>;
  /** Sends a message while the bot is still working on the last one. */
  sayNow(text: string): Promise<void>;
}

interface Case {
  name: string;
  /** Which todo items it measures. */
  items: string;
  run(r: Run): Promise<{ pass: boolean; note: string }>;
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const toolCalls = (message: Message, name: string) =>
  message.parts.filter((p) => p.type === "tool" && p.name === name).length;

const CASES: Case[] = [
  {
    name: "midturn",
    items: "1.1",
    async run(r) {
      const first = r.say(
        "Create a file plan.txt in your folder with the word alpha. Use your tools, then tell me when it's done.",
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await r.sayNow("Also create beta.txt with the word beta.");
      await first;
      // Let a follow-up turn for the second message finish, if one was needed.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const after = await r.say("Thanks. Which files are in your folder now? Don't create or change any.");
      const wrote = toolCalls(after, "write_file") + toolCalls(after, "edit_file");
      const beta = read(join(r.workspace, "beta.txt")).trim().toLowerCase();
      return {
        pass: beta === "beta" && wrote === 0,
        note: `beta.txt=${JSON.stringify(beta)}; writes in the last turn=${wrote}`,
      };
    },
  },
  {
    name: "offer",
    items: "1.2",
    async run(r) {
      const reply = await r.say(
        "Write three short facts about owls into owls.txt in your folder, then tell me they're saved and offer to add more.",
      );
      return {
        pass: reply.status === "done" && read(join(r.workspace, "owls.txt")).length > 0,
        note: messageText(reply).replace(/\s+/g, " ").slice(-100),
      };
    },
  },
  {
    name: "followup",
    items: "1.4, 2.1",
    async run(r) {
      await r.say("Name three popular Python web frameworks. Just the names, one per line.");
      const reply = await r.say(
        "Now compare those three: the year each was first released and what it's best for.",
      );
      const text = messageText(reply);
      const named = ["Django", "Flask", "FastAPI", "Pyramid", "Tornado"].filter((n) => text.includes(n));
      return { pass: named.length >= 3, note: `named: ${named.join(", ")}` };
    },
  },
  {
    name: "split",
    items: "1.3, 2.1, 3.1, 3.2",
    async run(r) {
      const reply = await r.say(
        "Compare the iPhone 15, the Pixel 8 and the Galaxy S24: release year, screen size and battery size for each. Answer from what you know.",
      );
      const text = messageText(reply);
      const named = ["iPhone 15", "Pixel 8", "Galaxy S24"].filter((n) => text.includes(n));
      return {
        pass: named.length === 3,
        note: `delegate calls=${toolCalls(reply, "delegate")}; named ${named.length}/3`,
      };
    },
  },
  {
    name: "third-job",
    items: "1.5",
    async run(r) {
      const jobs = [
        // Helpers are asked for outright, so three jobs need 9 helpers against a limit of 6.
        "Use three helpers, one per city: Rome, Paris and Madrid. Each says its city's population and river, from what it knows. Then combine them.",
        "Use three helpers, one per river: the Nile, the Amazon and the Yangtze. Each says its river's length, from what it knows. Then combine them.",
        "Use three helpers, one per planet: Mercury, Venus and Mars. Each says its planet's number of moons, from what it knows. Then combine them.",
      ];
      const notes: string[] = [];
      let failed = false;
      for (const job of jobs) {
        const reply = await r.say(job);
        const blocked = reply.parts.some(
          (p) =>
            p.type === "tool" && p.name === "delegate" && /already have \d+ helpers/.test(p.result ?? ""),
        );
        failed ||= blocked || reply.status !== "done";
        notes.push(
          `${toolCalls(reply, "delegate")} delegate${blocked ? " (blocked by the helper limit)" : ""}`,
        );
      }
      const helpers = r.services.store.bots.list().filter((bot) => bot.parentId === r.bot.id);
      notes.push(`${helpers.length} helpers at the end`);
      return { pass: !failed, note: notes.join("; ") };
    },
  },
];

function countingFetch(counts: { current: Counts }) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/api/chat") && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as { messages?: { role: string; content?: string }[] };
      const messages = body.messages ?? [];
      const c = counts.current;
      c.requests += 1;
      if (messages[0]?.content?.startsWith("You plan work for a coordinator bot")) c.planner += 1;
      const last = messages.at(-1)?.content ?? "";
      if (last.startsWith("(Before you finish, check your answer")) c.selfChecks += 1;
      if (last.startsWith("(You stopped without replying")) c.nudges += 1;
      const response = await fetch(input, init);
      if (!last.startsWith("(Before you finish, check your answer")) return response;
      // Read the self-check's reply to see whether it changed the answer, and hand back an identical stream.
      const text = await response.text();
      const said = text
        .split("\n")
        .flatMap((line) => {
          try {
            return [(JSON.parse(line) as { message?: { content?: string } }).message?.content ?? ""];
          } catch {
            return [];
          }
        })
        .join("");
      if (!/^\W*(ok\W*)?$/i.test(said.trim())) c.selfCheckChanges += 1;
      return new Response(text, { status: response.status, headers: response.headers });
    }
    return fetch(input, init);
  }) as typeof fetch;
}

async function runCase(model: string, test: Case, selfCheck: boolean) {
  const dataDir = mkdtempSync(join(tmpdir(), "mrog-maineval-"));
  const counts = {
    current: { requests: 0, planner: 0, selfChecks: 0, selfCheckChanges: 0, nudges: 0 } as Counts,
  };
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
    fetchImpl: countingFetch(counts),
  });
  store.settings.set("runtime", {
    ...DEFAULT_RUNTIME_SETTINGS,
    sharedModel: `ollama:${model}`,
    numCtx: 16384,
  });
  store.settings.set("agent", { maxSteps: 25, selfCheck, planning: true });
  services.agent.approvals.savePermissions({ localExecution: "never", rules: [] });
  const app = await buildServer(services);
  const bot = store.bots.create({ name: "Evie", isPrimary: true } as never) as Bot;
  const thread = store.threads.get(bot.threadId)!;
  const replyTo = () =>
    new Promise<Message>((resolve) => {
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
  const run: Run = {
    services,
    bot,
    workspace: services.agent.workspaceFor(bot.id),
    async say(text) {
      const done = replyTo();
      const timeout = setTimeout(() => services.turns.stop(thread.id), 600_000);
      await services.turns.send(thread, { text });
      const reply = await done;
      clearTimeout(timeout);
      return reply;
    },
    async sayNow(text) {
      await services.turns.send(thread, { text });
    },
  };
  const started = Date.now();
  let result: { pass: boolean; note: string };
  try {
    result = await test.run(run);
  } catch (error) {
    result = { pass: false, note: `failed: ${(error as Error).message}` };
  }
  await app.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  return {
    case: test.name,
    items: test.items,
    ...result,
    seconds: Math.round((Date.now() - started) / 1000),
    ...counts.current,
  };
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const only = args
  .find((arg) => arg.startsWith("--only="))
  ?.slice(7)
  .split(",");
const selfCheck = !args.includes("--no-self-check");
const models = args.filter((arg) => !arg.startsWith("--"));
if (models.length === 0) {
  console.error(
    "Name at least one Ollama model. --only=midturn,split picks cases; --no-self-check turns it off.",
  );
  process.exit(1);
}
const dir = join(import.meta.dirname, "results");
mkdirSync(dir, { recursive: true });
for (const model of models) {
  const results = [];
  for (const test of CASES.filter((c) => !only || only.includes(c.name))) {
    const result = await runCase(model, test, selfCheck);
    results.push(result);
    console.log(
      `${result.pass ? "PASS" : "FAIL"} ${result.case} (${result.items}) ${result.seconds}s requests=${result.requests} planner=${result.planner} selfChecks=${result.selfChecks} (changed ${result.selfCheckChanges}) nudges=${result.nudges} | ${result.note}`,
    );
    const file = join(
      dir,
      `main-bot-${model.replace(/[^\w.-]+/g, "_")}-${selfCheck ? "check" : "nocheck"}.json`,
    );
    writeFileSync(file, JSON.stringify({ model, selfCheck, at: new Date().toISOString(), results }, null, 2));
  }
}
process.exit(0);
