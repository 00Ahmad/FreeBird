import { z } from "zod";

import { MAX_SECRET_LENGTH, SECRET_TOO_LONG } from "./api";

export interface ProviderPreset {
  preset: string;
  label: string;
  kind: "openai" | "anthropic" | "ollama";
  group: "cloud" | "local" | "custom";
  baseUrl: string;
  /** Shown as the base URL placeholder when the user must type their own. */
  baseUrlHint?: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  local: boolean;
  keyHeader?: string;
  headers?: Record<string, string>;
  streamUsage?: boolean;
  fallbackModels?: string[];
  keyUrl?: string;
  /**
   * Environment variables the provider's own docs tell people to keep their key in, most preferred first. A key
   * already set in one can be added without pasting it.
   */
  envVars?: string[];
}

const cloud = (
  preset: string,
  label: string,
  baseUrl: string,
  extra: Partial<ProviderPreset> = {},
): ProviderPreset => ({
  preset,
  label,
  kind: "openai",
  group: "cloud",
  baseUrl,
  needsKey: true,
  needsBaseUrl: false,
  local: false,
  ...extra,
});

const localServer = (preset: string, label: string, baseUrl: string): ProviderPreset => ({
  preset,
  label,
  kind: "openai",
  group: "local",
  baseUrl,
  needsKey: false,
  needsBaseUrl: false,
  local: true,
  streamUsage: false,
});

export const PROVIDER_PRESETS: ProviderPreset[] = [
  cloud("openai", "OpenAI", "https://api.openai.com/v1", {
    keyUrl: "https://platform.openai.com/api-keys",
    envVars: ["OPENAI_API_KEY"],
  }),
  {
    ...cloud("anthropic", "Anthropic", "https://api.anthropic.com", {
      keyUrl: "https://console.anthropic.com/settings/keys",
      envVars: ["ANTHROPIC_API_KEY"],
    }),
    kind: "anthropic",
  },
  cloud("google", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", {
    keyUrl: "https://aistudio.google.com/apikey",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    streamUsage: false,
  }),
  cloud("groq", "Groq", "https://api.groq.com/openai/v1", {
    keyUrl: "https://console.groq.com/keys",
    envVars: ["GROQ_API_KEY"],
  }),
  cloud("xai", "xAI", "https://api.x.ai/v1", { keyUrl: "https://console.x.ai", envVars: ["XAI_API_KEY"] }),
  cloud("mistral", "Mistral", "https://api.mistral.ai/v1", {
    keyUrl: "https://console.mistral.ai/api-keys",
    envVars: ["MISTRAL_API_KEY"],
    streamUsage: false,
  }),
  cloud("deepseek", "DeepSeek", "https://api.deepseek.com/v1", {
    keyUrl: "https://platform.deepseek.com/api_keys",
    envVars: ["DEEPSEEK_API_KEY"],
    fallbackModels: ["deepseek-chat", "deepseek-reasoner"],
  }),
  cloud("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", {
    keyUrl: "https://openrouter.ai/keys",
    envVars: ["OPENROUTER_API_KEY"],
    headers: { "x-title": "FreeBird" },
  }),
  cloud("together", "Together AI", "https://api.together.xyz/v1", {
    keyUrl: "https://api.together.ai/settings/api-keys",
    envVars: ["TOGETHER_API_KEY"],
  }),
  cloud("fireworks", "Fireworks AI", "https://api.fireworks.ai/inference/v1", {
    keyUrl: "https://fireworks.ai/account/api-keys",
    envVars: ["FIREWORKS_API_KEY"],
  }),
  cloud("cerebras", "Cerebras", "https://api.cerebras.ai/v1", {
    keyUrl: "https://cloud.cerebras.ai",
    envVars: ["CEREBRAS_API_KEY"],
  }),
  // No variable for Azure: its key is useless without the resource's own address, which only the user knows.
  cloud("azure", "Azure OpenAI", "", {
    needsBaseUrl: true,
    baseUrlHint: "https://<resource>.openai.azure.com/openai/v1",
    keyHeader: "api-key",
  }),
  cloud("ollama-cloud", "Ollama Cloud", "https://ollama.com/v1", {
    keyUrl: "https://ollama.com/settings/keys",
    envVars: ["OLLAMA_API_KEY"],
  }),
  localServer("lmstudio", "LM Studio", "http://127.0.0.1:1234/v1"),
  localServer("vllm", "vLLM", "http://127.0.0.1:8000/v1"),
  localServer("llamacpp", "llama.cpp server", "http://127.0.0.1:8080/v1"),
  localServer("jan", "Jan", "http://127.0.0.1:1337/v1"),
  localServer("localai", "LocalAI", "http://127.0.0.1:8080/v1"),
  {
    preset: "ollama-remote",
    label: "Ollama (another computer)",
    kind: "ollama",
    group: "local",
    baseUrl: "",
    baseUrlHint: "http://192.168.1.20:11434",
    needsKey: false,
    needsBaseUrl: true,
    local: true,
  },
  {
    preset: "openai-compatible",
    label: "OpenAI-compatible",
    kind: "openai",
    group: "custom",
    baseUrl: "",
    baseUrlHint: "https://example.com/v1",
    needsKey: false,
    needsBaseUrl: true,
    local: false,
  },
  {
    preset: "anthropic-compatible",
    label: "Anthropic-compatible",
    kind: "anthropic",
    group: "custom",
    baseUrl: "",
    baseUrlHint: "https://example.com",
    needsKey: false,
    needsBaseUrl: true,
    local: false,
  },
];

export const presetFor = (preset: string) =>
  PROVIDER_PRESETS.find((candidate) => candidate.preset === preset);

export const ProviderConfig = z.object({
  /** Used in model refs ("<id>:<model>"); "ollama" is the built-in local runtime. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  preset: z.string(),
  label: z.string().min(1).max(60),
  baseUrl: z.string(),
  enabled: z.boolean(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const ProviderView = ProviderConfig.extend({
  hasKey: z.boolean(),
  local: z.boolean(),
  kind: z.enum(["openai", "anthropic", "ollama"]),
});
export type ProviderView = z.infer<typeof ProviderView>;

/**
 * A provider's key found in an environment variable on this computer, ready to add. Only the variable's name: its
 * value stays in the harness.
 */
export const FoundKey = z.object({
  preset: z.string(),
  label: z.string(),
  envVar: z.string(),
});
export type FoundKey = z.infer<typeof FoundKey>;

export const AddProviderInput = z.object({
  preset: z.string(),
  label: z.string().trim().min(1).max(60).optional(),
  baseUrl: z.url().optional(),
  apiKey: z.string().trim().min(1).max(MAX_SECRET_LENGTH, SECRET_TOO_LONG).optional(),
});
export type AddProviderInput = z.infer<typeof AddProviderInput>;

export const UpdateProviderInput = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  baseUrl: z.url().optional(),
  apiKey: z.string().trim().min(1).max(MAX_SECRET_LENGTH, SECRET_TOO_LONG).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateProviderInput = z.infer<typeof UpdateProviderInput>;

/** Keychain entry holding a provider's key. */
export const providerKeyName = (id: string) => `PROVIDER_${id.toUpperCase().replaceAll("-", "_")}_KEY`;
