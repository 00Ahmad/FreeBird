import { z } from "zod";

/** "providerId:modelId", e.g. "ollama:qwen3.5:9b" or "openai:gpt-5-mini". The model id may itself contain colons. */
export const ModelRef = z.string().regex(/^[a-z0-9][a-z0-9-]*:.+$/, "Expected provider:model");
export type ModelRef = z.infer<typeof ModelRef>;

export function parseModelRef(ref: string): { providerId: string; model: string } {
  const at = ref.indexOf(":");
  return { providerId: ref.slice(0, at), model: ref.slice(at + 1) };
}

export const modelRef = (providerId: string, model: string): ModelRef => `${providerId}:${model}`;

export const ModelCapability = z.enum(["completion", "tools", "vision", "thinking", "embedding"]);
export type ModelCapability = z.infer<typeof ModelCapability>;

export const ModelInfo = z.object({
  ref: ModelRef,
  providerId: z.string(),
  id: z.string(),
  label: z.string(),
  capabilities: z.array(ModelCapability),
  contextWindow: z.number().int().nullable(),
  sizeBytes: z.number().nullable(),
  /** Loaded in memory right now (local runtimes only). */
  loaded: z.boolean(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const RuntimeSettings = z.object({
  /** The one local model every bot uses unless it overrides it. */
  sharedModel: ModelRef.nullable(),
  /** Sent identically on every request so Ollama never reloads the model. */
  numCtx: z.number().int().min(1024).max(262_144),
  /** Ollama keep_alive: "30m", "2h", or "-1" to keep it loaded while the app runs. */
  keepAlive: z.string().regex(/^(-1|\d+[smh])$/),
  /** Turns run against the local model at once; the rest wait in the queue. */
  parallel: z.number().int().min(1).max(8),
  /** Parallel Bots with tools: how many of its three roles write at once (it takes one of the slots above). */
  parallelLanes: z.number().int().min(1).max(3).default(3),
  /** Parallel Bots with tools: the most tool steps each role may take before it must answer. */
  parallelSteps: z.number().int().min(1).max(10).default(6),
  /**
   * Parallel Bots without tools on a cloud model: ask each of the three roles in its own request, all at once (faster,
   * and the roles can't echo each other), instead of one request whose reply has three sections (fewer tokens). A local
   * model always uses the one request, so the GPU holds one conversation.
   */
  parallelSeparateOnCloud: z.boolean().default(true),
  /** Let thinking models reason before answering. */
  think: z.boolean(),
  ollamaUrl: z.url(),
  /** Start the local Ollama when the app opens, if it isn't already running. */
  startOllama: z.boolean(),
  /**
   * Keep one local model in memory at a time: when bots use different local models (a Coding Bot's Planner, Developer
   * and QA), each is loaded for its own turn and the others are unloaded first. Bots on the same model share it.
   */
  oneModelAtATime: z.boolean().default(true),
  /** When the app closes, unload the local models it loaded, freeing their memory. */
  unloadOnClose: z.boolean().default(true),
  /** When the app closes, stop Ollama too, but only if the app started it. */
  stopOllamaOnClose: z.boolean().default(true),
});
export type RuntimeSettings = z.infer<typeof RuntimeSettings>;

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  sharedModel: null,
  // Enough for tool-heavy work (browsing, research) while a 9B model still fits an 8 GB GPU.
  numCtx: 32768,
  keepAlive: "30m",
  parallel: 1,
  parallelLanes: 3,
  parallelSteps: 6,
  parallelSeparateOnCloud: true,
  think: false,
  ollamaUrl: "http://127.0.0.1:11434",
  startOllama: true,
  oneModelAtATime: true,
  unloadOnClose: true,
  stopOllamaOnClose: true,
};

export const LoadedModel = z.object({
  name: z.string(),
  sizeBytes: z.number(),
  vramBytes: z.number(),
  contextLength: z.number().nullable(),
  expiresAt: z.string().nullable(),
});
export type LoadedModel = z.infer<typeof LoadedModel>;

export const RuntimeStatus = z.object({
  ollama: z.object({ reachable: z.boolean(), version: z.string().nullable(), url: z.string() }),
  loaded: z.array(LoadedModel),
  settings: RuntimeSettings,
  queue: z.object({ running: z.number(), waiting: z.number() }),
});
export type RuntimeStatus = z.infer<typeof RuntimeStatus>;

/** Tool-capable models we suggest when nothing is installed yet, smallest first. */
export const RECOMMENDED_LOCAL_MODELS = [
  { id: "qwen3:4b", note: "Good tool use, fits 8 GB" },
  { id: "qwen3.5:9b", note: "Best quality on 12–16 GB GPUs" },
  { id: "llama3.2:3b", note: "Fast and small" },
] as const;
