/** Small text helpers every module shares: comparing words the way a person reads them, not byte by byte. */

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&ndash;": "-",
  "&mdash;": "-",
};

/**
 * Text folded for comparison: compatibility forms (full-width letters, ligatures), entities, curly quotes and dashes,
 * case, and runs of white space all count as the same. "£55,000 – £65,000" and "£55,000 - £65,000" are equal.
 */
export function fold(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[  -​  　]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "inc",
  "ltd",
  "llc",
  "gmbh",
  "plc",
  "co",
]);

/** The words that carry meaning ("Senior Backend Engineer (Remote)" → senior, backend, engineer, remote). */
export function words(text: string): string[] {
  return (fold(text).match(/[\p{L}\p{N}][\p{L}\p{N}+#.]*/gu) ?? [])
    .map((word) => word.replace(/\.+$/, ""))
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/** One line of at most `length` characters. */
export function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/** The list without repeats, by folded text, keeping the first spelling. */
export function unique(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = fold(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Plain text from a piece of HTML (a job system's description field): tags out, line breaks kept, entities read. */
export function stripHtml(html: string): string {
  const unescaped = html.replace(/&(lt|gt|quot|amp|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity);
  return unescaped
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
