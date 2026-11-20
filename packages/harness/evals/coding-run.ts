/**
 * One Coding Bot run against a real local model, measured: a fresh in-memory harness, a fresh empty output folder, the
 * brief sent, the run watched until it ends or times out, then counted from what the run itself recorded (every role
 * turn's message and every activity line as it was published), not from the board's totals. Used by the benchmark
 * (coding-bench.eval.ts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODING_ROLES,
  DEFAULT_BROWSER_SETTINGS,
  DEFAULT_RUNTIME_SETTINGS,
  isCodingBusy,
  type CodingProject,
  type CodingRole,
} from "@mrog/shared";
import { openStore } from "@mrog/store";
import { MemoryBackend, Vault } from "@mrog/vault";

import { buildServer, createServices, EventBus, settingsNameIndex, type Services } from "../src/index";

export interface RunOptions {
  brief: string;
  /** The model every role uses (an Ollama name), unless `roles` names another. */
  model: string;
  roles?: Partial<Record<CodingRole, string>>;
  visualQa: boolean;
  maxRounds: number;
  timeLimitMs: number;
  numCtx: number;
  ollamaUrl?: string;
}

export interface RoleStats {
  turns: number;
  toolCalls: number;
  /** Tool calls that ended in an error or were refused. */
  failedCalls: number;
  /** Turns that called no tool at all. */
  idleTurns: number;
  inputTokens: number;
  outputTokens: number;
  /** Turns whose model reported no token counts (or reported zero), so the totals above leave them out. */
  uncountedTurns: number;
}

export interface RunResult {
  status: CodingProject["status"];
  error: string | null;
  seconds: number;
  timedOut: boolean;
  rounds: number;
  files: number;
  connections: number;
  cards: number;
  roles: Record<CodingRole, RoleStats>;
  /** Every activity line the run published, in order (the project itself keeps only the last 50). */
  activity: string[];
  /** Command approval cards the run answered (commands Auto-approve didn't cover). */
  approvalsAnswered: number;
}

/** What a finished run left behind, for the brief's own check of whether it works. */
export interface RunOutput {
  outDir: string;
  project: CodingProject;
  services: Services;
}

const emptyStats = (): RoleStats => ({
  turns: 0,
  toolCalls: 0,
  failedCalls: 0,
  idleTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  uncountedTurns: 0,
});

/** Runs the brief once; `inspect` is called with the finished output before everything is cleaned up. */
export async function runCodingProject<T>(
  options: RunOptions,
  inspect: (output: RunOutput) => Promise<T>,
): Promise<{ result: RunResult; checked: T }> {
  const dataDir = mkdtempSync(join(tmpdir(), "freebird-bench-data-"));
  const outDir = mkdtempSync(join(tmpdir(), "freebird-bench-out-"));
  const store = openStore(":memory:");
  const bus = new EventBus();
  const vault = new Vault(new MemoryBackend(), settingsNameIndex(store.settings));
  const services = createServices({
    config: {
      host: "127.0.0.1",
      port: 0,
      token: "bench",
      dataDir,
      uiOrigins: [],
      uiDist: null,
      heartbeatMs: 60_000,
      vault: "memory",
      keyringService: "freebird-bench",
      previousKeyringService: null,
      eventLog: false,
    },
    store,
    vault,
    bus,
  });
  store.settings.set("runtime", {
    ...DEFAULT_RUNTIME_SETTINGS,
    sharedModel: `ollama:${options.model}`,
    numCtx: options.numCtx,
    ...(options.ollamaUrl ? { ollamaUrl: options.ollamaUrl } : {}),
  });
  // Commands ask (Auto-approve covers QA's routine ones); the rest are answered "allow once" below, as a user would, in
  // a throwaway folder.
  services.agent.approvals.savePermissions({ localExecution: "ask", rules: [] });
  store.settings.set("browser", { ...DEFAULT_BROWSER_SETTINGS, show: false, profiles: "shared" });
  const app = await buildServer(services);

  const model = (role: CodingRole) =>
    options.roles?.[role] ? { model: `ollama:${options.roles[role]}` } : {};
  const { bot, project } = await services.coding.create({
    name: "Bench Team",
    outputFolder: outDir,
    roles: { planner: model("planner"), developer: model("developer"), qa: model("qa") },
    autoApprove: true,
    visualQa: options.visualQa,
    maxRounds: options.maxRounds,
  });

  // Every activity line, as published (the project keeps only its last 50).
  const activity: string[] = [];
  const logged = new Set<string>();
  bus.subscribe((event) => {
    if (event.type !== "coding.updated" || event.project.botId !== bot.id) return;
    for (const line of event.project.log ?? []) {
      const key = `${line.at}|${line.text}`;
      if (logged.has(key)) continue;
      logged.add(key);
      activity.push(line.text);
    }
  });

  // Command cards Auto-approve didn't cover are answered "allow once".
  const answered = new Set<string>();
  bus.subscribe((event) => {
    if (event.type !== "message.updated" || event.message.threadId !== bot.threadId) return;
    for (const part of event.message.parts)
      if (part.type === "tool" && part.status === "pending_approval" && part.approval) {
        if (answered.has(part.approval.id)) continue;
        answered.add(part.approval.id);
        void app.inject({
          method: "POST",
          url: `/api/approvals/${part.approval.id}`,
          headers: { authorization: "Bearer bench" },
          payload: { decision: "allow_once" },
        });
      }
  });

  const started = Date.now();
  await services.turns.send(store.threads.get(bot.threadId)!, { text: options.brief });
  let final: CodingProject = project;
  let timedOut = false;
  for (;;) {
    final = services.coding.get(bot.id)!;
    if (!isCodingBusy(final.status) && final.status !== "setup") break;
    if (Date.now() - started > options.timeLimitMs) {
      timedOut = true;
      await services.coding.stop(bot.id);
      final = services.coding.get(bot.id)!;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const seconds = Math.round((Date.now() - started) / 1000);

  // Each role's turns, from the role bots' own messages.
  const roles = Object.fromEntries(CODING_ROLES.map((role) => [role, emptyStats()])) as Record<
    CodingRole,
    RoleStats
  >;
  const roleOf = new Map(CODING_ROLES.map((role) => [final.roles[role].botId, role]));
  for (const thread of store.threads.list())
    for (const message of store.messages.list(thread.id)) {
      const role = message.botId ? roleOf.get(message.botId) : undefined;
      if (!role || message.role !== "bot") continue;
      const stats = roles[role];
      const tools = message.parts.filter((part) => part.type === "tool");
      stats.turns += 1;
      stats.toolCalls += tools.length;
      stats.failedCalls += tools.filter((part) => part.status === "error" || part.status === "denied").length;
      if (tools.length === 0) stats.idleTurns += 1;
      const usage = message.usage;
      if (!usage || (usage.inputTokens === 0 && usage.outputTokens === 0)) stats.uncountedTurns += 1;
      else {
        stats.inputTokens += usage.inputTokens;
        stats.outputTokens += usage.outputTokens;
      }
    }

  const result: RunResult = {
    status: final.status,
    error: final.error,
    seconds,
    timedOut,
    rounds: final.round,
    files: final.nodes.length,
    connections: final.edges.length,
    cards: final.cards.length,
    roles,
    activity,
    approvalsAnswered: answered.size,
  };
  try {
    const checked = await inspect({ outDir, project: final, services });
    return { result, checked };
  } finally {
    await services.browser.close().catch(() => {});
    await app.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}
