/**
 * End-of-run reports against real local models: a cluster discussion's summary and a race judge's report must come
 * out whole (every section there and filled in, a winner named). Usage:
 *   pnpm --filter @mrog/harness exec tsx evals/reports.eval.ts qwen3.5:9b ornith-1.5:9b
 * Each model named runs one cluster (as its moderator) and one race (as its judge); the experts and racers are
 * spread over every model named. EVAL_ONLY=cluster or EVAL_ONLY=race runs just one. Reports are written to
 * evals/results/.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BROWSER_SETTINGS,
  DEFAULT_RUNTIME_SETTINGS,
  messageText,
  type Discussion,
  type Race,
} from "@mrog/shared";
import { openStore } from "@mrog/store";
import { MemoryBackend, Vault } from "@mrog/vault";

import { summaryGaps } from "../src/discussion";
import { judgeGaps } from "../src/race";
import { createServices, EventBus, settingsNameIndex } from "../src/index";

const TOPIC =
  process.env.EVAL_TOPIC ??
  "Should a small neighbourhood bakery with six staff move to a four-day work week?";
const TASK =
  process.env.EVAL_TASK ??
  "Write a 30-day plan for an adult beginner to learn touch typing, with daily practice times and how to measure progress.";
const NAMES = ["Asha", "Bilal", "Chen", "Dana", "Emre"];
const LIMIT_MS = 40 * 60_000;

async function harness(model: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "mrog-reporteval-"));
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
  store.settings.set("runtime", { ...DEFAULT_RUNTIME_SETTINGS, sharedModel: `ollama:${model}` });
  // Research stays on, in a hidden window, so nothing pops up while it runs.
  store.settings.set("browser", { ...DEFAULT_BROWSER_SETTINGS, show: false });
  services.agent.approvals.savePermissions({ localExecution: "never", rules: [] });
  const close = async () => {
    for (const dispose of services.disposers) await Promise.resolve(dispose()).catch(() => {});
    await services.browser.close?.().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  };
  return { services, store, bus, close };
}

const until = <T>(check: () => T | null, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const value = check();
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 2000);
  });

async function cluster(model: string, everyone: string[]) {
  const { services, store, close } = await harness(model);
  const started = Date.now();
  try {
    const { thread } = await services.discussions.createCluster({
      topic: TOPIC,
      goal: "decide",
      rounds: 2,
      members: everyone.slice(0, 3).map((member, i) => ({
        name: NAMES[i]!,
        expertise: ["Small-business owner", "Labour economist", "Sceptical accountant"][i]!,
        personality: [
          "Practical, has run a café for twenty years; cares about staff and cash flow.",
          "Knows the four-day-week trials and their evidence; careful about what they show.",
          "Doubts every claim until the numbers add up; checks the others' sources.",
        ][i]!,
        model: `ollama:${member}`,
      })),
    });
    const state = await until<Discussion>(() => {
      const now = services.discussions.get(thread.id);
      return now && !["running", "summarizing"].includes(now.status) ? now : null;
    }, LIMIT_MS).catch(() => {
      services.discussions.stop(thread.id);
      return services.discussions.get(thread.id)!;
    });
    const summary = state.summaryId ? store.messages.get(state.summaryId) : null;
    const text = summary ? messageText(summary) : "";
    const gaps = state.status === "done" ? summaryGaps(text, state.goal) : [`ended ${state.status}`];
    return {
      kind: "cluster",
      model,
      seconds: Math.round((Date.now() - started) / 1000),
      status: state.status,
      error: state.error,
      gaps,
      text,
    };
  } finally {
    await close();
  }
}

async function race(model: string, everyone: string[]) {
  const { services, store, close } = await harness(model);
  const started = Date.now();
  try {
    const { thread } = await services.races.start({
      task: TASK,
      racers: everyone.slice(0, 3).map((racer, i) => ({ name: NAMES[i]!, model: `ollama:${racer}` })),
      judge: { model: `ollama:${model}` },
    });
    const state = await until<Race>(() => {
      const now = services.races.get(thread.id);
      return now && !["racing", "judging"].includes(now.status) ? now : null;
    }, LIMIT_MS).catch(() => {
      services.races.end(thread.id, "stopped");
      return services.races.get(thread.id)!;
    });
    const report = state.reportId ? store.messages.get(state.reportId) : null;
    const text = report ? messageText(report) : "";
    const gaps = state.status === "done" ? judgeGaps(text) : [`ended ${state.status}`];
    if (state.status === "done" && !state.winnerId) gaps.push("no winner");
    // Each racer's outcome, so a judge that skipped a racer can be told from a racer that failed.
    const lanes = state.racers
      .map((racer) => `${store.bots.get(racer.botId)?.name ?? "?"} ${racer.status}`)
      .join(", ");
    return {
      kind: "race",
      model,
      seconds: Math.round((Date.now() - started) / 1000),
      status: state.status,
      error: state.error,
      gaps,
      text: `Racers: ${lanes}\n\n${text}`,
    };
  } finally {
    await close();
  }
}

const models = process.argv.slice(2);
if (models.length === 0) {
  console.error("Name at least one Ollama model.");
  process.exit(1);
}
// Experts and racers: every model named, then the first again to make three.
const everyone = [...models, ...models, ...models].slice(0, 3);
const only = process.env.EVAL_ONLY;
const out = join(import.meta.dirname, "results");
mkdirSync(out, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
const results = [];
for (const model of models) {
  for (const kind of ["cluster", "race"] as const) {
    if (only && only !== kind) continue;
    const result = await (kind === "cluster" ? cluster(model, everyone) : race(model, everyone)).catch(
      (error: unknown) => ({
        kind,
        model,
        seconds: 0,
        status: "crashed",
        error: (error as Error).message,
        gaps: ["crashed"],
        text: "",
      }),
    );
    results.push(result);
    console.log(
      `${result.gaps.length === 0 ? "PASS" : "FAIL"}  ${kind.padEnd(7)} ${model.padEnd(32)} ${result.seconds}s  ${result.status}${result.error ? ` (${result.error})` : ""}${result.gaps.length ? `  missing: ${result.gaps.join("; ")}` : ""}`,
    );
  }
}
writeFileSync(
  join(out, `reports-${stamp}.md`),
  results
    .map(
      (r) =>
        `# ${r.kind} · ${r.model} · ${r.gaps.length ? `FAIL (${r.gaps.join("; ")})` : "PASS"} · ${r.seconds}s\n\n${r.text || "(no report)"}`,
    )
    .join("\n\n---\n\n"),
);
console.log(`\nReports: ${join(out, `reports-${stamp}.md`)}`);
process.exit(results.every((r) => r.gaps.length === 0) ? 0 : 1);
