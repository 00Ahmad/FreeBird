import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Copies of files a bot changed with write_file or edit_file, kept so the user can undo a change from the chat. Plain
 * files under the data folder, one folder per bot: `<id>.bak` holds the file as it was (none when there was no file),
 * `<id>.json` says where it goes back to and what the bot wrote. The path to restore is only ever the one recorded
 * here, never one a request names.
 */

/** Larger files are still written, but no copy is kept. */
export const MAX_KEPT_BYTES = 4 * 1024 * 1024;
/** Copies kept per bot; the oldest go first. */
export const MAX_KEPT_PER_BOT = 100;
/** A copy with no record this old belongs to a write that failed. */
const STRAY_AFTER_MS = 60 * 60_000;

/** What a kept copy is for. */
export interface FileVersion {
  id: string;
  botId: string;
  threadId: string;
  /** The bot's own message whose tool call changed the file. */
  messageId: string;
  callId: string;
  /** The file the call changed, as the tool resolved it. */
  path: string;
  /** Whether the file existed before the call (if not, undo deletes it). */
  existed: boolean;
  /** sha256 of what the call wrote: a file that no longer matches was changed again since. */
  writtenHash: string;
  at: string;
  undone: boolean;
}

/** Ids are made here; anything else is refused before it can name a path. */
const ID = /^fv_[a-f0-9]{32}$/;
export const isVersionId = (id: string) => ID.test(id);

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export type UndoResult =
  | { ok: true; version: FileVersion }
  | { ok: false; code: "not_found" | "already_undone" | "changed_since" | "busy"; message: string };

export function createFileHistory(root: string) {
  const folderOf = (botId: string) => join(root, botId.replace(/[^\w-]/g, "_"));

  /** Every bot folder's versions by id, found by reading the folder names (ids are unique across bots). */
  const locate = async (id: string): Promise<string | null> => {
    if (!isVersionId(id)) return null;
    const bots = await readdir(root).catch(() => [] as string[]);
    for (const bot of bots) {
      const meta = join(root, bot, `${id}.json`);
      if (await stat(meta).catch(() => null)) return join(root, bot);
    }
    return null;
  };

  const readMeta = async (folder: string, id: string): Promise<FileVersion | null> => {
    try {
      return JSON.parse(await readFile(join(folder, `${id}.json`), "utf8")) as FileVersion;
    } catch {
      return null;
    }
  };

  /**
   * Drops the oldest copies past MAX_KEPT_PER_BOT, and copies left without a record (the write after them failed)
   * once they are an hour old.
   */
  const prune = async (folder: string) => {
    const names = await readdir(folder).catch(() => [] as string[]);
    const recorded = new Set(names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)));
    for (const stray of names.filter((name) => name.endsWith(".bak") && !recorded.has(name.slice(0, -4)))) {
      const info = await stat(join(folder, stray)).catch(() => null);
      if (info && Date.now() - info.mtimeMs > STRAY_AFTER_MS) await rm(join(folder, stray), { force: true });
    }
    const metas = names.filter((name) => name.endsWith(".json"));
    if (metas.length <= MAX_KEPT_PER_BOT) return;
    const dated = await Promise.all(
      metas.map(async (name) => ({ name, at: (await readMeta(folder, name.slice(0, -5)))?.at ?? "" })),
    );
    for (const { name } of dated
      .toSorted((a, b) => a.at.localeCompare(b.at))
      .slice(0, metas.length - MAX_KEPT_PER_BOT)) {
      const id = name.slice(0, -5);
      await rm(join(folder, `${id}.json`), { force: true });
      await rm(join(folder, `${id}.bak`), { force: true });
    }
  };

  /**
   * Keeps a copy of `path` as it is now, before a call changes it. The function returned saves the record once the
   * call has written (with what it wrote) and gives the version's id; undefined when the file is too large to keep.
   */
  const keep = async (
    owner: { botId: string; threadId: string; messageId: string; callId: string },
    path: string,
  ): Promise<((written: string) => Promise<FileVersion | null>) | undefined> => {
    const info = await stat(path).catch(() => null);
    if (info?.isDirectory()) return undefined;
    if (info && info.size > MAX_KEPT_BYTES) return undefined;
    const folder = folderOf(owner.botId);
    await mkdir(folder, { recursive: true });
    const id = `fv_${randomUUID().replaceAll("-", "")}`;
    if (info) await copyFile(path, join(folder, `${id}.bak`));
    return async (written) => {
      const version: FileVersion = {
        id,
        ...owner,
        path,
        existed: info !== null,
        writtenHash: sha(written),
        at: new Date().toISOString(),
        undone: false,
      };
      await writeFile(join(folder, `${id}.json`), JSON.stringify(version), "utf8");
      await prune(folder);
      return version;
    };
  };

  const get = async (id: string): Promise<FileVersion | null> => {
    const folder = await locate(id);
    return folder ? readMeta(folder, id) : null;
  };

  /**
   * Puts the file back as it was before the call (or removes it, if the call created it). A file changed again since
   * is left alone unless `force`: undoing would also throw away the later change.
   */
  const undo = async (id: string, force = false): Promise<UndoResult> => {
    const folder = await locate(id);
    const version = folder ? await readMeta(folder, id) : null;
    if (!folder || !version)
      return { ok: false, code: "not_found", message: "That change can no longer be undone." };
    if (version.undone)
      return { ok: false, code: "already_undone", message: "That change was already undone." };
    const now = await readFile(version.path).catch(() => null);
    if (!force && (now === null || sha(now) !== version.writtenHash))
      return {
        ok: false,
        code: "changed_since",
        message:
          now === null
            ? "The file has been deleted since. Undo anyway to put back the version from before this change."
            : "The file was changed again since. Undoing puts back the version from before this change, and the later changes are lost.",
      };
    if (version.existed) {
      await mkdir(dirname(version.path), { recursive: true });
      await copyFile(join(folder, `${id}.bak`), version.path);
    } else await unlink(version.path).catch(() => undefined);
    const done = { ...version, undone: true };
    await writeFile(join(folder, `${id}.json`), JSON.stringify(done), "utf8");
    return { ok: true, version: done };
  };

  /** Deletes a bot's kept copies (the bot was deleted). */
  const forgetBot = (botId: string) => rm(folderOf(botId), { recursive: true, force: true });

  return { keep, get, undo, forgetBot };
}

export type FileHistory = ReturnType<typeof createFileHistory>;
