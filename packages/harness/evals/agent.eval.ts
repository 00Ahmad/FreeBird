/**
 * Agent-loop eval against real local models. Usage:
 *   pnpm --filter @mrog/harness eval -- qwen3.5:9b nemotron-3-nano:4b [--allow-commands]
 * Needs Ollama running with those models pulled. Each model gets a fresh bot and data folder.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_RUNTIME_SETTINGS, messageText, type Bot, type Message } from "@mrog/shared";
import { openStore } from "@mrog/store";
import { MemoryBackend, Vault } from "@mrog/vault";

import { buildServer, createServices, EventBus, settingsNameIndex } from "../src/index";

interface Task {
  prompt: string;
  /** Needs the model to run shell commands on this machine: only with --allow-commands. */
  commands?: boolean;
  check(ctx: { reply: Message; workspace: string }): boolean;
}

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

const TASKS: Task[] = [
  {
    prompt:
      "Create a file named notes.txt in your folder containing exactly the word banana. Use your tools.",
    check: ({ workspace }) => read(join(workspace, "notes.txt")).trim().toLowerCase() === "banana",
  },
  {
    prompt: "Read notes.txt from your folder and tell me the word inside it.",
    check: ({ reply }) =>
      /banana/i.test(messageText(reply)) &&
      reply.parts.some((p) => p.type === "tool" && p.name === "read_file"),
  },
  {
    prompt:
      "Run a terminal command that prints the current year, then save just that year into year.txt in your folder.",
    commands: true,
    check: ({ workspace, reply }) =>
      read(join(workspace, "year.txt")).includes(String(new Date().getFullYear())) &&
      reply.parts.some((p) => p.type === "tool" && p.name === "run_command"),
  },
  {
    prompt: "List the files in your folder and tell me how many files there are.",
    check: ({ reply, workspace }) => {
      const expected = read(join(workspace, "year.txt")) ? 2 : 1;
      return new RegExp(`\\b(${expected}|${expected === 2 ? "two" : "one"})\\b`, "i").test(
        messageText(reply),
      );
    },
  },
];

async function evalModel(model: string, allowCommands: boolean) {
  const dataDir = mkdtempSync(join(tmpdir(), "mrog-eval-"));
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
    sharedModel: `ollama:${model}`,
    numCtx: 8192,
  });
  // No one is there to click approval cards, so commands are refused unless the person running the eval
  // opts in. File tools stay confined to the bot's own temporary folder either way.
  services.agent.approvals.savePermissions({ localExecution: allowCommands ? "always" : "never", rules: [] });
  const app = await buildServer(services);
  const bot = store.bots.create({ name: "Evie" }) as Bot;
  const thread = store.threads.get(bot.threadId)!;
  const workspace = services.agent.workspaceFor(bot.id);

  const results: { task: number; pass: boolean; seconds: number; tools: string[]; reply: string }[] = [];
  for (const [index, task] of TASKS.entries()) {
    if (task.commands && !allowCommands) continue;
    const started = Date.now();
    const done = new Promise<Message>((resolve) => {
      const off = bus.subscribe((event) => {
        if (
          event.type === "message.updated" &&
          event.message.botId === bot.id &&
          event.message.status !== "streaming"
        ) {
          off();
          resolve(event.message);
        }
      });
    });
    const timeout = setTimeout(() => services.turns.stop(thread.id), 180_000);
    await services.turns.send(thread, { text: task.prompt });
    const reply = await done;
    clearTimeout(timeout);
    results.push({
      task: index + 1,
      pass: reply.status === "done" && task.check({ reply, workspace }),
      seconds: Math.round((Date.now() - started) / 100) / 10,
      tools: reply.parts.flatMap((p) =>
        p.type === "tool"
          ? [
              `${p.name}:${p.status}${p.status === "error" ? `(${JSON.stringify(p.args)} → ${p.result?.slice(0, 160)})` : ""}`,
            ]
          : [],
      ),
      reply: messageText(reply).replace(/\s+/g, " ").slice(0, 120),
    });
  }
  await app.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  return results;
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const allowCommands = args.includes("--allow-commands");
const models = args.filter((arg) => !arg.startsWith("--"));
if (models.length === 0) {
  console.error("Name at least one Ollama model. Add --allow-commands to include the shell task.");
  process.exit(1);
}
for (const model of models) {
  const results = await evalModel(model, allowCommands);
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${model}: ${passed}/${results.length} passed ===`);
  for (const r of results) {
    console.log(
      `${r.pass ? "PASS" : "FAIL"} #${r.task} ${r.seconds}s tools=[${r.tools.join(", ")}] reply="${r.reply}"`,
    );
  }
}
process.exit(0);
