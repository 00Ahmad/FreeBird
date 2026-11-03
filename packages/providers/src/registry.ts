import { parseModelRef } from "@mrog/shared";

import { ProviderError, type ChatProvider } from "./types";

/** Every configured provider, looked up by the id at the front of a model ref. */
export class ProviderRegistry {
  private readonly providers = new Map<string, ChatProvider>();

  register(provider: ChatProvider): void {
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): void {
    this.providers.delete(id);
  }

  get(id: string): ChatProvider | undefined {
    return this.providers.get(id);
  }

  list(): ChatProvider[] {
    return [...this.providers.values()];
  }

  resolve(ref: string): { provider: ChatProvider; model: string } {
    const { providerId, model } = parseModelRef(ref);
    const provider = this.providers.get(providerId);
    if (!provider)
      throw new ProviderError("model_missing", `No provider "${providerId}" is set up for ${ref}.`);
    return { provider, model };
  }
}
