/** Adds selected text to a draft as a block quote (Cmd/Ctrl+L), leaving room to write below it. */
export function quoteInto(draft: string, selection: string): string {
  const trimmed = selection.trim();
  if (!trimmed) return draft;
  const quote = trimmed
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">"))
    .join("\n");
  const before = draft.trimEnd();
  return `${before ? `${before}\n\n` : ""}${quote}\n\n`;
}
