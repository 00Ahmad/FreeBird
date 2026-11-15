import { mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { nameProblem } from "./coding-paths";

/** A refusal the person can act on: the message is shown as it is. */
export class CodingError extends Error {
  constructor(
    message: string,
    readonly code = "invalid_request",
    readonly status = 400,
  ) {
    super(message);
    this.name = "CodingError";
  }
}

/** Where a path really points, following links (for a path that doesn't exist yet, its nearest parent that does). */
function realPath(abs: string): string {
  let rest = "";
  let current = abs;
  for (;;) {
    try {
      return join(realpathSync.native(current), rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return abs;
      rest = join(basename(current), rest);
      current = parent;
    }
  }
}

// Windows and macOS file systems ignore case: "C:\Work" and "c:\work" are one folder.
const foldCase = (path: string) =>
  process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;

/** Whether `child` is `root` or somewhere inside it. */
function within(root: string, child: string): boolean {
  const rel = relative(foldCase(root), foldCase(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface FolderRules {
  /** The app's own data folder: the database and every bot's private folder live in it. */
  dataDir: string;
  /** The output folders other Coding Bots already write to. */
  taken: string[];
  /** The person's home folder (tests pass their own). */
  home?: string;
}

const example =
  process.platform === "win32" ? "C:\\Users\\you\\Projects\\my-app" : "/home/you/projects/my-app";

const NOT_LOCAL = `The output folder must be on one of this computer's own drives, like ${example}: a network share or a device path (one that starts with \\\\ or //) can't be checked against your home folder and the app's folders.`;

/**
 * Checks the folder a Coding Bot will write its project into, creates it when it isn't there, and returns it as an
 * absolute path. It is where the team's file tools work without asking, so it must not be a place the app or the
 * person needs for other things: a drive root, the home folder (or a folder holding it), the app's data folder or
 * another bot's output folder, in either direction.
 */
export function checkOutputFolder(input: string, rules: FolderRules): string {
  const given = input.trim();
  if (!given) throw new CodingError("Choose an output folder.");
  // Before anything touches the disk: a share (\\server\share, \\localhost\C$) or a device path (\\?\, \\.\) can be
  // the home folder under another name, which the checks below compare as text and would not recognise.
  if (/^[\\/]{2}/.test(given)) throw new CodingError(NOT_LOCAL);
  if (!isAbsolute(given))
    throw new CodingError(`The output folder must be a full path, like ${example}. “${given}” is relative.`);
  if (process.platform === "win32" && /[<>:"|?*]/.test(given.replace(/^[A-Za-z]:/, "")))
    throw new CodingError(`“${given}” has characters a folder name can't have (< > : " | ? *).`);
  const abs = resolve(given);
  if (dirname(abs) === abs)
    throw new CodingError("A drive root can't be the output folder. Pick or create a folder inside it.");
  // "C:\Users\me." is "C:\Users\me" to a command but a new folder to Node: the checks and the team would disagree.
  for (const name of [...given.split(/[\\/]/), ...abs.split(/[\\/]/)]) {
    const problem = name && name !== "." && name !== ".." ? nameProblem(name) : null;
    if (problem) throw new CodingError(`The output folder can't be ${abs}: ${problem}. Pick another name.`);
  }

  const real = realPath(abs);
  if (/^[\\/]{2}/.test(real))
    throw new CodingError(`${abs} leads to a network folder (${real}). ${NOT_LOCAL}`);
  const home = realPath(resolve(rules.home ?? homedir()));
  if (within(real, home))
    throw new CodingError(
      within(home, real)
        ? "The output folder can't be your home folder itself. Pick a folder inside it, such as a new Projects folder."
        : "The output folder can't be a folder that holds your home folder.",
    );
  const data = realPath(resolve(rules.dataDir));
  if (within(data, real) || within(real, data))
    throw new CodingError(
      "The output folder can't be the app's own data folder, or inside it or around it: the app keeps its database and every bot's private folder there.",
    );
  for (const other of rules.taken) {
    const theirs = realPath(resolve(other));
    if (within(theirs, real) || within(real, theirs))
      throw new CodingError(`Another Coding Bot already writes to ${other}. Pick a different folder.`);
  }

  try {
    mkdirSync(abs, { recursive: true });
    if (!statSync(abs).isDirectory()) throw new Error("it is a file, not a folder");
  } catch (error) {
    throw new CodingError(`Couldn't use ${abs} as the output folder: ${(error as Error).message}`);
  }
  // Writing is the only real test of writing: permissions, read-only drives and sync clients all show up here.
  const probe = join(abs, `.freebird-write-check-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
  } catch (error) {
    throw new CodingError(`Can't write to ${abs}: ${(error as Error).message}`);
  }
  return abs;
}
