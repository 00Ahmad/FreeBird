import type { CodingEdge, CodingNode } from "@mrog/shared";

import { ApiRequestError } from "./api";

/** What the server's dry run says about a plan. */
export interface ImportPreview {
  ok: boolean;
  files: number;
  connections: number;
  errors: string[];
  /** Files from the plan that already exist in the output folder: the Developer would change them. */
  existing: string[];
  nodes: CodingNode[];
  edges: CodingEdge[];
}

/** A file bigger than this is not a plan. */
export const MAX_IMPORT_BYTES = 1_000_000;

export type ImportInput = { ok: true; plan: unknown } | { ok: false; problem: string };

/**
 * What to send for text from a file or the paste box. A whole JSON object goes as an object; anything else (a chat
 * reply with the JSON inside, say) goes as text for the server's reader to find the plan in.
 */
export function importInput(text: string): ImportInput {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, problem: "Choose a file or paste the plan first." };
  if (trimmed.length > MAX_IMPORT_BYTES)
    return { ok: false, problem: "That is too big to be a plan (over 1 MB). Is it the right file?" };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, plan: parsed };
  } catch {
    // Not pure JSON: probably a reply with the plan inside it.
  }
  return { ok: true, plan: trimmed };
}

/** Applying makes sense only for a plan the server understood, with something in it. */
export const canApplyImport = (preview: ImportPreview | null): boolean =>
  Boolean(preview && preview.ok && preview.errors.length === 0 && preview.files > 0);

/** "6 files and 4 connections", with the right plurals. */
export function previewCounts(preview: Pick<ImportPreview, "files" | "connections">): string {
  const files = `${preview.files} ${preview.files === 1 ? "file" : "files"}`;
  const connections = `${preview.connections} ${preview.connections === 1 ? "connection" : "connections"}`;
  return `${files} and ${connections}`;
}

const SHOWN_EXISTING = 8;

/** A warning naming the plan's files that are already in the output folder, or null when none are. */
export function existingWarning(existing: readonly string[]): string | null {
  if (existing.length === 0) return null;
  const shown = existing.slice(0, SHOWN_EXISTING).join(", ");
  const more = existing.length - SHOWN_EXISTING;
  return `${existing.length} ${existing.length === 1 ? "file already exists" : "files already exist"} in the output folder and the Developer would change ${existing.length === 1 ? "it" : "them"}: ${shown}${more > 0 ? ` and ${more} more` : ""}.`;
}

/** The server says the board has already moved: applying needs a confirmed reset. */
export function needsReplace(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.status === 409 &&
    (error.raw as { needsReplace?: unknown } | null)?.needsReplace === true
  );
}
