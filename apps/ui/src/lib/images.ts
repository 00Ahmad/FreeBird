/**
 * Whether an image in chat text is the app's own, shown without asking. Only inline data and blob: images are:
 * anything else is an address on the network, and fetching it tells that server what was in the chat.
 */
export function isAppOwnImage(src: string | undefined): boolean {
  if (!src) return false;
  const lower = src.trim().toLowerCase();
  return lower.startsWith("data:image/") || lower.startsWith("blob:");
}

/** The site an image would be loaded from, for the "Load image" prompt; null when the address names none. */
export function imageHost(src: string | undefined): string | null {
  if (!src) return null;
  try {
    return new URL(src.trim()).host || null;
  } catch {
    return null;
  }
}
