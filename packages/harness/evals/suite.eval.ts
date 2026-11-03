/**
 * The eval suite: real local models on real tasks, scored the same way every run, so a change to the app or a
 * different model can be compared by numbers instead of impressions. Usage:
 *   pnpm --filter @mrog/harness exec tsx evals/suite.eval.ts <model> [<model>…] [--live] [--only=name,name]
 * Offline tasks use a local fixture shop and are repeatable. --live adds a task on the real web. Bots never run
 * shell commands here (nobody is watching to approve them). SHOW=1 shows the browser window; NUM_CTX sets the
 * context size (default 65536). Writes a Markdown report to evals/results/.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BROWSER_SETTINGS,
  DEFAULT_RUNTIME_SETTINGS,
  messageText,
  type Message,
  type MessagePart,
} from "@mrog/shared";
import { openStore, type Store } from "@mrog/store";
import { MemoryBackend, Vault } from "@mrog/vault";

import { shop } from "../src/fixtures/shop";
import { buildServer, createServices, EventBus, settingsNameIndex } from "../src/index";

type ToolPart = Extract<MessagePart, { type: "tool" }>;

interface Context {
  reply: Message;
  final: string;
  /** Every tool call in the reply (a coordinator's includes its helpers' approvals, not their calls). */
  tools: ToolPart[];
  /** Tool calls made by every bot in the run, helpers included. */
  allTools: ToolPart[];
  workspace: string;
  store: Store;
  shopUrl: string;
}

interface Task {
  name: string;
  what: string;
  live?: boolean;
  /** The bot is a coordinator that can create helpers. */
  coordinator?: boolean;
  /** The bot is a Visual Bot (screenshots only); live visual tasks show the browser window. */
  visual?: boolean;
  prompt(shopUrl: string): string;
  checks(ctx: Context): Record<string, boolean>;
}

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

const used = (tools: ToolPart[], name: string) => tools.some((t) => t.name === name && t.status === "done");
const guessed = (tools: ToolPart[]) =>
  tools.filter((t) => t.result?.includes("this address doesn't exist")).length;

/** Pages a Visual Bot actually had on screen (from the address bar line of its screenshots). */
const sawPage = (tools: ToolPart[], pattern: RegExp) =>
  tools.some((t) =>
    (t.result ?? "").split("\n").some((line) => line.startsWith("Address bar: ") && pattern.test(line)),
  );

const TASKS: Task[] = [
  {
    name: "files",
    what: "Write a Markdown table to a file, read it back",
    prompt: () =>
      "Create report.md in your folder containing a Markdown table of three fruits and their colors. Then read the file back and tell me how many fruits it lists.",
    checks: ({ workspace, final }) => ({
      file: /\|\s*-{3,}/.test(read(join(workspace, "report.md"))),
      answer: /\b(3|three)\b/i.test(final),
    }),
  },
  {
    name: "shop-search",
    what: "Use a JavaScript shop's own search box, cite the product page",
    prompt: (url) =>
      `The shop at ${url} sells phones. Use the shop's own search box to search for "phone", then tell me the cheapest phone, its price and the address of its product page.`,
    checks: ({ tools, final, shopUrl }) => ({
      browser: used(tools, "browser_type") || used(tools, "browser_open"),
      name: /Nova 5/i.test(final),
      price: /29,?999/.test(final),
      sourced: final.includes(`${shopUrl}/p/1`) || final.includes("/p/1"),
    }),
  },
  {
    name: "no-guessing",
    what: "Find a product page by navigating, not by guessing addresses",
    prompt: (url) =>
      `On the shop at ${url}, find the product page of the Pixelto A2 and tell me its price and the page's address.`,
    checks: ({ tools, final }) => ({
      price: /34,?500/.test(final),
      sourced: final.includes("/p/2"),
      noGuess: guessed(tools) === 0,
    }),
  },
  {
    name: "plan",
    what: "Show a checklist for a multi-step task and finish every step",
    prompt: () =>
      "Do these steps in order: 1) write a.txt containing one, 2) write b.txt containing two, 3) list the files in your folder, 4) tell me what each file contains.",
    checks: ({ tools, workspace, final }) => ({
      planned: used(tools, "update_plan"),
      files: read(join(workspace, "a.txt")).includes("one") && read(join(workspace, "b.txt")).includes("two"),
      answer: /\bone\b/i.test(final) && /\btwo\b/i.test(final),
    }),
  },
  {
    name: "pipeline",
    what: "Coordinator: one helper finds, a second checks it with the first's results",
    coordinator: true,
    prompt: (url) =>
      `Create two helpers, Finder and Checker. Have Finder find the cheapest phone and its price on the shop at ${url} (using the shop's search box). Then have Checker verify Finder's answer by opening that phone's product page itself: pass Finder's results to it with include_results_from. Then tell me the verified phone, price and product page address.`,
    checks: ({ tools, final, store }) => ({
      helpers: store.bots.list().filter((bot) => bot.parentId !== null).length >= 2,
      // Finder's results reached Checker: attached with include_results_from, or written into its task.
      passedOn: tools.some((t) => {
        const args = JSON.stringify(t.args);
        return (
          t.name === "delegate" &&
          args.includes("Checker") &&
          (/include_results_from":\[?"Finder/.test(args) || /29,?999|Nova/.test(args))
        );
      }),
      name: /Nova 5/i.test(final),
      price: /29,?999/.test(final),
    }),
  },
  {
    name: "visual-shop",
    what: "Visual Bot: find a product's price in a JavaScript shop by looking",
    visual: true,
    prompt: (url) =>
      `Go to the shop at ${url}. Using its search box, find the Pixelto A2 phone, open its page and tell me its price.`,
    checks: ({ tools, final }) => ({
      clicked: used(tools, "screen_click") || used(tools, "screen_click_at"),
      opened: sawPage(tools, /\/p\/2/),
      price: /34,?500/.test(final),
    }),
  },
  {
    name: "visual-google",
    what: "Visual Bot (live): Google → GSMArena page → battery size",
    visual: true,
    live: true,
    prompt: () =>
      "Use Google to find the GSMArena page of the vivo Y19s, open it, and tell me its battery size.",
    checks: ({ tools, final }) => ({
      google: sawPage(tools, /google\.[a-z.]+\/search/),
      gsmarena: sawPage(tools, /gsmarena\.com\/vivo_y19s/),
      battery: /5[,.]?500\s?mAh/i.test(final),
    }),
  },
  {
    name: "visual-youtube",
    what: "Visual Bot (live): YouTube search → open a video → title and channel",
    visual: true,
    live: true,
    prompt: () =>
      "Go to YouTube, search for a review of the vivo Y19s, open one of the review videos, and tell me the video's title and channel name.",
    checks: ({ tools, final }) => ({
      searched: sawPage(tools, /youtube\.com\/results/),
      video: sawPage(tools, /youtube\.com\/watch/),
      answer: /y19s/i.test(final),
    }),
  },
  {
    name: "web-research",
    what: "Real web: a phone's price on daraz.pk and its battery on GSMArena",
    live: true,
    prompt: () =>
      "Find the price of a vivo Y19s on daraz.pk (any listing) and its battery size from GSMArena. Give me the price, the battery size, and the address of each page you used.",
    checks: ({ tools, final }) => ({
      browser: tools.some((t) => t.name.startsWith("browser_") && t.status === "done"),
      price: /Rs\.?\s?[\d,]{4,}/i.test(final),
      battery: /\d[,.]?\d{3}\s?mAh/i.test(final),
      sourced: /daraz\.pk\/\S+/.test(final) && /gsmarena\.com\/\S+/.test(final),
    }),
  },
];

interface Result {
  model: string;
  task: Task;
  pass: boolean;
  failed: string[];
  seconds: number;
  toolCalls: number;
  toolErrors: number;
  status: string;
  /** For failures: what the bot did and said, to see why. */
  trail: string[];
  final: string;
}

async function runTask(model: string, task: Task, shopUrl: string): Promise<Result> {
  const dataDir = mkdtempSync(join(tmpdir(), "mrog-suite-"));
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
    numCtx: Number(process.env.NUM_CTX ?? 65_536),
  });
  store.settings.set("browser", {
    ...DEFAULT_BROWSER_SETTINGS,
    show: process.env.SHOW === "1" || Boolean(task.visual && task.live),
  });
  // Nobody can click approval cards here: allow what the tasks need (the fixture shop is on this computer, so
  // opening it would ask), and refuse commands outright.
  const allow = (tool: string) => ({
    id: `eval-${tool}`,
    tool,
    match: null,
    decision: "allow" as const,
    createdAt: new Date().toISOString(),
  });
  services.agent.approvals.savePermissions({
    localExecution: "never",
    rules: [allow("browser_open"), allow("spawn_bot"), allow("fetch_url"), allow("screen_go_to")],
  });
  // Nor can anyone answer questions: say so, and let the bot carry on or report what it couldn't do.
  services.agent.questions.ask = async () =>
    "(Nobody is available to help right now. Continue on your own, or say plainly what you couldn't do.)";
  const app = await buildServer(services);
  const bot = store.bots.create({
    name: "Scout",
    isPrimary: task.coordinator ?? false,
    visual: task.visual ?? false,
  });
  const thread = store.threads.get(bot.threadId)!;

  const started = Date.now();
  const done = new Promise<Message>((resolve) => {
    const off = bus.subscribe((event) => {
      if (
        event.type === "message.updated" &&
        event.message.botId === bot.id &&
        event.message.threadId === bot.threadId &&
        event.message.status !== "streaming"
      ) {
        off();
        resolve(event.message);
      }
    });
  });
  const timeout = setTimeout(() => services.turns.stop(thread.id), (task.live ? 8 : 5) * 60_000);
  await services.turns.send(thread, { text: task.prompt(shopUrl) });
  const reply = await done;
  clearTimeout(timeout);

  const toolsOf = (message: Message) => message.parts.filter((p): p is ToolPart => p.type === "tool");
  const allTools = store.threads
    .list()
    .flatMap((t) => store.messages.list(t.id, { limit: 400 }))
    .filter((m) => m.role === "bot")
    .flatMap(toolsOf);
  const final = messageText(reply);
  const checks = task.checks({
    reply,
    final,
    tools: toolsOf(reply),
    allTools,
    workspace: services.agent.workspaceFor(bot.id),
    store,
    shopUrl,
  });
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  if (reply.status !== "done") failed.unshift(`status:${reply.status}`);

  await services.browser.close();
  await app.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  return {
    model,
    task,
    pass: failed.length === 0,
    failed,
    seconds: Math.round((Date.now() - started) / 1000),
    toolCalls: allTools.length,
    toolErrors: allTools.filter((t) => t.status === "error").length,
    status: reply.status,
    trail: allTools.map(
      (t) =>
        `${t.name} [${t.status}] ${JSON.stringify(t.args).slice(0, 140)}${t.status === "error" ? ` → ${t.result?.slice(0, 140)}` : ""}`,
    ),
    final,
  };
}

function report(results: Result[]): string {
  const lines = [`# Eval suite, ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, ""];
  const settings = `Context ${Number(process.env.NUM_CTX ?? 65_536).toLocaleString()} tokens.`;
  lines.push(settings, "");
  for (const model of new Set(results.map((r) => r.model))) {
    const mine = results.filter((r) => r.model === model);
    const passed = mine.filter((r) => r.pass).length;
    lines.push(
      `## ${model}: ${passed}/${mine.length} passed`,
      "",
      "| Task | Result | Failed checks | Time | Tool calls | Tool errors |",
      "|---|---|---|---|---|---|",
      ...mine.map(
        (r) =>
          `| ${r.task.name} (${r.task.what}) | ${r.pass ? "PASS" : "FAIL"} | ${r.failed.join(", ") || "none"} | ${r.seconds}s | ${r.toolCalls} | ${r.toolErrors} |`,
      ),
      "",
    );
    for (const r of mine.filter((result) => !result.pass)) {
      lines.push(
        `### Why ${r.task.name} failed`,
        "",
        "Tool calls:",
        "",
        ...r.trail.map((step) => `- \`${step.replaceAll("`", "'")}\``),
        "",
        "Final answer:",
        "",
        ...r.final.split("\n").map((line) => `> ${line}`),
        "",
      );
    }
  }
  return lines.join("\n");
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const models = args.filter((arg) => !arg.startsWith("--"));
const live = args.includes("--live");
const only = args
  .find((arg) => arg.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",");
const tasks = TASKS.filter((task) => (live || !task.live) && (!only || only.includes(task.name)));
if (models.length === 0) {
  console.log("Usage: tsx evals/suite.eval.ts <model> [<model>…] [--live] [--only=task,task]");
  console.log(`Tasks: ${TASKS.map((t) => `${t.name}${t.live ? " (live)" : ""}`).join(", ")}`);
  process.exit(1);
}

const server: Server = shop();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const shopUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const results: Result[] = [];
for (const model of models) {
  for (const task of tasks) {
    const result = await runTask(model, task, shopUrl);
    results.push(result);
    console.log(
      `${result.pass ? "PASS" : "FAIL"}  ${model}  ${task.name.padEnd(13)} ${String(result.seconds).padStart(4)}s  tools ${result.toolCalls}${result.failed.length ? `  failed: ${result.failed.join(", ")}` : ""}`,
    );
  }
}
server.close();

const text = report(results);
const dir = join(import.meta.dirname, "results");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const file = join(dir, `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`);
writeFileSync(file, text);
console.log(`\n${text}\nReport: ${file} (${readdirSync(dir).length} reports so far)`);
process.exit(0);
