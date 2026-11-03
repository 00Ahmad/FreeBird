import { presetFor, type ProviderConfig } from "@mrog/shared";

import { AnthropicProvider } from "./anthropic";
import { isLocalUrl } from "./guess";
import { OllamaProvider } from "./ollama";
import { OpenAICompatProvider } from "./openai";
import type { ChatProvider } from "./types";

/** Builds the provider for a saved config. `apiKey` is read on every request so key changes apply at once. */
export function createProvider(
  config: ProviderConfig,
  apiKey: () => string | null,
  fetchImpl: typeof fetch = fetch,
): ChatProvider {
  const preset = presetFor(config.preset);
  if (!preset) throw new Error(`Unknown provider type "${config.preset}".`);
  const baseUrl = config.baseUrl || preset.baseUrl;
  switch (preset.kind) {
    case "anthropic":
      return new AnthropicProvider({ id: config.id, label: config.label, baseUrl, apiKey, fetchImpl });
    case "ollama":
      return new OllamaProvider(config.id, config.label, () => baseUrl, fetchImpl);
    case "openai":
      return new OpenAICompatProvider({
        id: config.id,
        label: config.label,
        baseUrl,
        apiKey,
        keyHeader: preset.keyHeader,
        headers: preset.headers,
        local: preset.local || isLocalUrl(baseUrl),
        streamUsage: preset.streamUsage,
        fallbackModels: preset.fallbackModels,
        flattenTools: preset.local || isLocalUrl(baseUrl),
        fetchImpl,
      });
  }
}
