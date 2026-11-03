/**
 * Coordinator eval against real local models: the primary bot creates two helpers, delegates to both in
 * parallel and combines their answers. Usage:
 *   pnpm --filter @mrog/harness exec tsx evals/delegation.eval.ts qwen3.5:9b
 * Commands stay refused. Helpers on the shared model are created without a card, so nothing is pre-approved. Set
 * EVAL_PROMPT to a job that never mentions helpers to check that the coordinator decides to use them by itself.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_RUNTIME_SETTINGS, messageText, type Message } from "@mrog/shared";
import { openStore } from "@mrog/store";
import { MemoryBackend, Vault } from "@mrog/vault";

import { buildServer, createServices, EventBus, settingsNameIndex } from "../src/index";

const PROMPT =
  process.env.EVAL_PROMPT ??
  "Create two helper bots with spawn_bot: FruitBot (names fruits) and VeggieBot (names vegetables). Then call delegate once with both tasks: ask FruitBot for 3 fruits and VeggieBot for 3 vegetables. Finally give me one combined list.";

async function run(model: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "mrog-deleval-"));
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
  services.agent.approvals.savePermissions({ localExecution: "never", rules: [] });
  const app = await buildServer(services);
  const boss = store.bots.create({ name: "Chief", isPrimary: true });
  const thread = store.threads.get(boss.threadId)!;

  const started = Date.now();
  const done = new Promise<Message>((resolve) => {
    const off = bus.subscribe((event) => {
      if (
        event.type === "message.updated" &&
        event.message.botId === boss.id &&
        event.message.threadId === boss.threadId &&
        event.message.status !== "streaming"
      ) {
        off();
        resolve(event.message);
      }
    });
  });
  const timeout = setTimeout(() => services.turns.stop(thread.id), 300_000);
  await services.turns.send(thread, { text: PROMPT });
  const reply = await done;
  clearTimeout(timeout);

  const helpers = store.bots.list().filter((bot) => bot.parentId === boss.id);
  const tools = reply.parts.flatMap((part) => (part.type === "tool" ? [part] : []));
  const delegation = tools.find((part) => part.name === "delegate" && part.status === "done");
  const answered = helpers.filter((helper) => delegation?.result?.includes(`## ${helper.name}`));
  const pass = helpers.length >= 2 && answered.length >= 2 && reply.status === "done";
  console.log(
    `\n=== ${model}: ${pass ? "PASS" : "FAIL"} in ${Math.round((Date.now() - started) / 1000)}s ===`,
  );
  console.log(
    `helpers: ${helpers.map((h) => `${h.name}${h.hidden ? " (hidden after)" : ""}`).join(", ") || "none"}`,
  );
  console.log(`tools: ${tools.map((t) => `${t.name}:${t.status}`).join(", ")}`);
  console.log(`delegate result: ${delegation?.result?.replace(/\s+/g, " ").slice(0, 300) ?? "(none)"}`);
  console.log(`final: ${messageText(reply).replace(/\s+/g, " ").slice(0, 300)}`);

  await app.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
}

for (const model of process.argv.slice(2).filter((arg) => arg !== "--")) await run(model);
process.exit(0);
