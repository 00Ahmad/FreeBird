import { z } from "zod";

/** A bot reply saved to the Library: a copy, so it stays even if the chat is cleared or the bot deleted. */
export const LibraryItem = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  botName: z.string().nullable(),
  /** Where it came from, while that chat still exists. */
  threadId: z.string().nullable(),
  messageId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type LibraryItem = z.infer<typeof LibraryItem>;

export const SaveToLibraryInput = z.object({
  messageId: z.string().min(1),
  title: z.string().trim().min(1).max(200).optional(),
});

export const RenameLibraryItemInput = z.object({ title: z.string().trim().min(1).max(200) });

/** A title from a reply: its first heading, or the start of its first line (a table is named by its columns). */
export function libraryTitle(text: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(text)?.[1];
  let first = heading ?? text.split("\n").find((line) => line.trim()) ?? "Saved reply";
  if (!heading && first.trim().startsWith("|")) {
    const columns = first
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    first = `Table: ${columns.join(", ")}`;
  }
  const plain = first.replace(/[*_`#>[\]]/g, "").trim();
  return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain || "Saved reply";
}
