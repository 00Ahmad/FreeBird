import { isAbsolute, relative, resolve } from "node:path";

import type { Bot, CodingProject, CodingRole, Permissions } from "@mrog/shared";
import { BADGES, type Risk } from "@mrog/tools";

import { secretFileReason } from "./coding-paths";
import { codingRoleOf } from "./coding-skills";

/** What still shows a card with Auto-approve on: a command that can't be undone, or that reaches past the project. */
const STILL_ASKS: readonly string[] = [
  BADGES.irreversible,
  BADGES.security,
  BADGES.secrets,
  BADGES.outside,
  BADGES.network,
  BADGES.shares,
];

/**
 * A command that writes its output into a file (`echo … > notes.js`, `>>`): QA changes no files, so this still asks.
 * Sending output nowhere (`2>&1`, `> $null`, `> /dev/null`, `> nul`) doesn't count, nor do `=>` and `->`.
 */
export const writesToFile = (command: string): boolean =>
  /(?<![\d&=-])>>?\s*(?!&|\$null\b|nul\b|\/dev\/null\b)[^\s>]/i.test(command) ||
  /(?<![\w-])(?:New-Item|ni|Add-Content|ac|Copy-Item|copy|cp|cpi|Tee-Object|tee|Rename-Item|ren|rni|Set-Item|touch|mkdir|md)(?![\w-])/i.test(
    command,
  );

/** The words of a command that look like paths: split on spaces, quotes and shell punctuation. */
const pathsIn = (command: string): string[] =>
  command
    .split(/[\s"'`;|&(),{}]+/)
    .map((word) => word.replace(/^[<>]+/, ""))
    .filter((word) => /[\\/.]/.test(word) && !word.startsWith("-"));

/**
 * Why a command reaches past what QA may touch unseen: a secret file (`.env`, a private key, `.npmrc`), or a path
 * outside the project folder (an absolute one elsewhere, or `..` out of it). Null when it stays inside.
 */
export function reachesPast(command: string, folder: string): string | null {
  const root = resolve(folder);
  for (const word of pathsIn(command)) {
    if (secretFileReason(word)) return `it names ${word}, which may hold secrets`;
    if (/^https?:\/\//i.test(word)) continue;
    const absolute = isAbsolute(word) || /^[A-Za-z]:[\\/]/.test(word) || word.startsWith("~");
    if (!absolute && !word.split(/[\\/]/).includes("..")) continue;
    const rel = relative(root, resolve(root, word.replace(/^~/, "/")));
    if (rel.startsWith("..") || isAbsolute(rel)) return `it names ${word}, outside the project folder`;
  }
  return null;
}

/** Whether Auto-approve covers this command: a routine one (checking, installing, running) inside the project. */
export function routineCommand(risk: Risk, command: string | undefined, folder: string): boolean {
  if (risk.kind !== "terminal" || risk.badges.some((badge) => STILL_ASKS.includes(badge))) return false;
  // The command itself, all of it; failing that, the card's summary without its folder and secrets lines.
  const text = command ?? risk.summary.replace(/\n\((in|with) [^\n]*\)$/gm, "");
  return !writesToFile(text) && reachesPast(text, folder) === null;
}

/** Whether a quick check may start an app with its own command: Auto-approve on, and commands not set to never. */
export const quickCommandsAllowed = (
  autoApprove: boolean,
  localExecution: Permissions["localExecution"],
): boolean => autoApprove && localExecution !== "never";

/** The roles whose commands Auto-approve covers: QA's (it is the only role that runs any). */
const AUTO_ROLES: readonly CodingRole[] = ["qa"];

/**
 * A Coding Bot's Auto-approve covers its QA's routine commands as well as the plan: QA checks, installs and runs the
 * project without a card each time. Anything that can't be undone, changes security, gets secrets, writes a file,
 * names a secret file or works outside the project folder still asks.
 */
export const codingAutoApprove =
  (
    getBot: (id: string) => Bot | null | undefined,
    getProject: (codingBotId: string) => CodingProject | null,
  ) =>
  (botId: string, risk: Risk, command?: string): boolean => {
    const bot = getBot(botId);
    if (!bot?.parentId || risk.kind !== "terminal") return false;
    const project = getProject(bot.parentId);
    if (!project?.autoApprove) return false;
    const role = codingRoleOf(bot, getBot, getProject);
    return role !== null && AUTO_ROLES.includes(role) && routineCommand(risk, command, project.outputFolder);
  };
