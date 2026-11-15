/**
 * Paths inside a Coding Bot's output folder that its roles must not touch, even though the folder is theirs. Paths are
 * relative to the output folder; slashes may be either way round and case doesn't matter (Windows and macOS).
 */

const parts = (path: string) =>
  path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .map((part) => part.toLowerCase());

/** Folders that belong to tools, not to the project: writing there can make code run on the user's next command. */
const TOOL_FOLDERS = new Set([".git", ".hg", ".svn", "node_modules", ".husky", ".direnv"]);

/** Editor and tool settings that run commands when the user opens or builds the project. */
const RUNS_COMMANDS = new Set([
  ".vscode/tasks.json",
  ".vscode/launch.json",
  ".vscode/settings.json",
  ".vscode/extensions.json",
  ".idea/workspace.xml",
  ".gitattributes",
  ".gitmodules",
  ".envrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
]);

/**
 * Why a role may not write this path, or null when it may. A plan may not list such a path either: nothing about a
 * project needs the team to write into `.git` or an editor's task runner, and both are a way to run commands without
 * asking.
 */
export function protectedPathReason(path: string): string | null {
  const segments = parts(path);
  if (segments.length === 0) return "it is the project folder itself";
  const folder = segments.find((segment) => TOOL_FOLDERS.has(segment));
  if (folder) return `files in ${folder} belong to a tool, not to the project`;
  if (RUNS_COMMANDS.has(segments.join("/")))
    return "that settings file can run commands when the project is opened";
  if (segments[0] === ".idea" && segments.at(-1)?.endsWith(".xml") && segments.includes("runconfigurations"))
    return "that settings file can run commands when the project is opened";
  return null;
}

/** Names Windows keeps for devices, in any case and with any extension: "nul.txt" is the null device, not a file. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i;

/**
 * What is wrong with one file or folder name on Windows (the strictest system), or null. Windows quietly drops a
 * dot or space at the end of a name, so "app." is "app" to one program and a different folder to another.
 */
export function nameProblem(name: string): string | null {
  if (DEVICE_NAME.test(name.split(".")[0]!.trimEnd()))
    return `“${name}” is a name Windows keeps for a device`;
  if (/[. ]$/.test(name)) return `“${name}” ends in a dot or a space, which Windows drops from a name`;
  return null;
}

/** A file that may hold real secrets, which a role must not read (its text would go to the model). */
export function secretFileReason(path: string): string | null {
  const name = parts(path).at(-1) ?? "";
  if (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist)$/.test(name))
    return "it may hold real secrets";
  if (/\.(pem|key|p12|pfx|keystore|jks)$/.test(name) || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name))
    return "it is a private key";
  if (name === ".npmrc" || name === ".pypirc" || name === ".netrc" || name === "credentials.json")
    return "it may hold real credentials";
  return null;
}
