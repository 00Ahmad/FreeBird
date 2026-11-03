import type { ModelCapability } from "@mrog/shared";

/**
 * `/models` on most cloud APIs lists ids only. These name-based guesses fill in what the picker shows;
 * the user can still pick any model.
 */
const NOT_CHAT =
  /(embed|^bge|\be5-|minilm|nomic-embed|whisper|tts|transcribe|dall-?e|image|moderation|audio|realtime|search-preview|rerank|davinci|babbage|guard|ocr)/i;
const VISION =
  /(gpt-4o|gpt-4\.1|gpt-5|o3|o4|claude|gemini|pixtral|llava|-vl|vision|llama-4|grok-4|grok-2-vision|qwen.*vl|gemma-3|mistral-medium|mistral-small)/i;
const THINKING =
  /(^o\d|\/o\d|gpt-5|reason|r1|thinking|claude-(opus|sonnet)-4|claude-.*-4|gemini-2\.5|gemini-3|grok-3-mini|grok-4|qwq|magistral)/i;
const NO_TOOLS = /(gpt-3\.5-turbo-instruct|o1-mini|deepseek-reasoner$|-instruct-v0\.1)/i;

export function isChatModel(id: string): boolean {
  return !NOT_CHAT.test(id);
}

export function guessCapabilities(id: string): ModelCapability[] {
  const caps: ModelCapability[] = ["completion"];
  if (!NO_TOOLS.test(id)) caps.push("tools");
  if (VISION.test(id)) caps.push("vision");
  if (THINKING.test(id)) caps.push("thinking");
  return caps;
}

const CONTEXT: [RegExp, number][] = [
  [/gemini/i, 1_000_000],
  [/gpt-4\.1/i, 1_000_000],
  [/claude/i, 200_000],
  [/gpt-5|o3|o4/i, 200_000],
  [/grok-4/i, 256_000],
  [/deepseek/i, 64_000],
];

export function guessContextWindow(id: string): number {
  return CONTEXT.find(([pattern]) => pattern.test(id))?.[1] ?? 128_000;
}

/** A base URL on this machine or the local network: no per-token cost, shares local hardware. */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$)|\.local$/i.test(host);
  } catch {
    return false;
  }
}
