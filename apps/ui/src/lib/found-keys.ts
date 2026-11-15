import type { FoundKey, ProviderView } from "@mrog/shared";

/** How a found key is listed: the provider and where its key was found, never the key. */
export function foundKeyText(found: Pick<FoundKey, "label" | "envVar">): string {
  return `${found.label} (from ${found.envVar})`;
}

/** The Add button's accessible name, so a screen reader hears which provider each one adds. */
export function addFoundLabel(found: Pick<FoundKey, "label">): string {
  return `Add ${found.label}`;
}

/**
 * The found keys still worth offering. The harness already leaves out providers that are set up, but its answer can
 * be a moment older than the provider list, and a row offering one already in that list would only fail.
 */
export function offeredKeys(found: FoundKey[], providers: Pick<ProviderView, "preset">[]): FoundKey[] {
  const added = new Set(providers.map((provider) => provider.preset));
  return found.filter((key) => !added.has(key.preset));
}
