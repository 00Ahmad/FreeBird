import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { displayPath, resolvePath } from "./paths";
import { formatCommandResult, looksDestructive, looksSecuritySensitive, runShell } from "./shell";
import { BADGES, defineTool, safe, type Risk, type ToolContext, type ToolSpec } from "./types";
import { addressRisk, fetchReadable, mayReachLocal } from "./web";

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", "dist", ".next"]);
const MAX_READ_BYTES = 512 * 1024;

/** File access is free inside the bot's folder; anywhere else it asks. */
function fileRisk(ctx: ToolContext, path: string, verb: string, write: boolean): Risk {
  const { abs, inside } = resolvePath(ctx.workspace, path);
  if (inside) return safe(`${verb} ${displayPath(ctx.workspace, abs)}`);
  return {
    level: "ask",
    kind: "general",
    badges: write ? [BADGES.outside, BADGES.irreversible] : [BADGES.outside],
    summary: `${verb} ${abs}`,
  };
}

const listFiles = defineTool({
  name: "list_files",
  description: "List files and folders. Paths are relative to your own folder unless absolute.",
  args: z.object({
    path: z.string().default(".").describe("Folder to list"),
    depth: z.number().int().min(1).max(4).default(2).describe("How many levels deep"),
  }),
  risk: (args, ctx) => fileRisk(ctx, args.path, "List", false),
  async run(args, ctx) {
    const { abs } = resolvePath(ctx.workspace, args.path);
    await mkdir(ctx.workspace, { recursive: true });
    const lines: string[] = [];
    const walk = async (dir: string, level: number) => {
      const entries = (await readdir(dir, { withFileTypes: true })).toSorted((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (lines.length >= 500) return;
        const indent = "  ".repeat(level);
        if (entry.isDirectory()) {
          lines.push(`${indent}${entry.name}/`);
          if (level + 1 < args.depth && !SKIP_DIRS.has(entry.name))
            await walk(join(dir, entry.name), level + 1);
        } else {
          lines.push(`${indent}${entry.name}`);
        }
      }
    };
    await walk(abs, 0);
    return lines.length
      ? lines.join("\n") + (lines.length >= 500 ? "\n…(more not shown)" : "")
      : "(empty folder)";
  },
});

const readFileTool = defineTool({
  name: "read_file",
  description: "Read a text file. Use offset/limit (in lines) for long files.",
  args: z.object({
    path: z.string().describe("File to read"),
    offset: z.number().int().min(1).default(1).describe("First line (1-based)"),
    limit: z.number().int().min(1).max(2000).default(400).describe("Number of lines"),
  }),
  risk: (args, ctx) => fileRisk(ctx, args.path, "Read", false),
  async run(args, ctx) {
    const { abs } = resolvePath(ctx.workspace, args.path);
    const info = await stat(abs);
    if (info.isDirectory()) return `${args.path} is a folder. Use list_files.`;
    if (info.size > MAX_READ_BYTES * 8) return `${args.path} is ${info.size} bytes, too large to read.`;
    const lines = (await readFile(abs, "utf8")).split(/\r?\n/);
    const slice = lines.slice(args.offset - 1, args.offset - 1 + args.limit);
    const more =
      args.offset - 1 + args.limit < lines.length
        ? `\n…(${lines.length} lines total; read more with offset)`
        : "";
    return slice.map((line, i) => `${args.offset + i}| ${line}`).join("\n") + more;
  },
});

const writeFileTool = defineTool({
  name: "write_file",
  description: "Create or overwrite a text file (folders are created as needed).",
  args: z.object({
    path: z.string().describe("File to write"),
    content: z.string().describe("Full new content"),
  }),
  risk: (args, ctx) => fileRisk(ctx, args.path, "Write", true),
  async run(args, ctx) {
    const { abs } = resolvePath(ctx.workspace, args.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, args.content, "utf8");
    return `Wrote ${Buffer.byteLength(args.content)} bytes to ${displayPath(ctx.workspace, abs)}.`;
  },
});

const editFile = defineTool({
  name: "edit_file",
  description: "Replace exact text in a file. `find` must match exactly once unless all=true.",
  args: z.object({
    path: z.string(),
    find: z.string().min(1).describe("Exact text to replace"),
    replace: z.string().describe("Replacement text"),
    all: z.boolean().default(false).describe("Replace every match"),
  }),
  risk: (args, ctx) => fileRisk(ctx, args.path, "Edit", true),
  async run(args, ctx) {
    const { abs } = resolvePath(ctx.workspace, args.path);
    const text = await readFile(abs, "utf8");
    const count = text.split(args.find).length - 1;
    if (count === 0) return "No match: `find` was not found. Read the file and copy the text exactly.";
    if (count > 1 && !args.all)
      return `${count} matches: make \`find\` longer so it matches once, or set all=true.`;
    await writeFile(
      abs,
      // A function, so `$&`, `$1` and the like in the replacement stay as written.
      args.all ? text.split(args.find).join(args.replace) : text.replace(args.find, () => args.replace),
      "utf8",
    );
    return `Replaced ${args.all ? count : 1} match(es) in ${displayPath(ctx.workspace, abs)}.`;
  },
});

const searchFiles = defineTool({
  name: "search_files",
  description: "Find lines containing text (case-insensitive) in files under a folder.",
  args: z.object({ query: z.string().min(1), path: z.string().default(".") }),
  risk: (args, ctx) => fileRisk(ctx, args.path, "Search", false),
  async run(args, ctx) {
    const { abs } = resolvePath(ctx.workspace, args.path);
    const needle = args.query.toLowerCase();
    const hits: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (hits.length >= 200 || ctx.signal.aborted) return;
        const full = join(dir, entry.name);
        // A link or junction may lead out of the folder, where reading asks first: search only what is really here.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(full);
          continue;
        }
        const info = await stat(full).catch(() => null);
        if (!info || info.size > MAX_READ_BYTES) continue;
        const text = await readFile(full, "utf8").catch(() => "");
        if (text.includes("\u0000")) continue;
        text.split(/\r?\n/).forEach((line, i) => {
          if (hits.length < 200 && line.toLowerCase().includes(needle)) {
            hits.push(`${displayPath(ctx.workspace, full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      }
    };
    await walk(abs);
    return hits.length ? hits.join("\n") : "No matches.";
  },
});

const runCommand = defineTool({
  name: "run_command",
  description:
    process.platform === "win32"
      ? "Run a command in Windows PowerShell 5.1 (not bash) on this computer. Runs in your own folder unless cwd is given. Write PowerShell: variables start with $, `curl` is Invoke-WebRequest (no -s/-L/-A flags), and there is no grep, head, /tmp or /dev/null (use Select-String, Select-Object -First, your folder, $null). To read a web page, use fetch_url instead."
      : "Run a shell command on this computer. Runs in your own folder unless cwd is given.",
  // A model may send the names as one string ("A, B") or a single name.
  prepare: (args) => ({
    ...args,
    secrets:
      typeof args.secrets === "string"
        ? args.secrets.split(/[\s,]+/).filter(Boolean)
        : Array.isArray(args.secrets) && args.secrets.length === 0
          ? undefined
          : args.secrets,
  }),
  args: z.object({
    command: z.string().min(1).describe("The command line"),
    cwd: z.string().optional().describe("Working folder"),
    timeout_seconds: z.number().int().min(1).max(600).default(120),
    secrets: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(10)
      .optional()
      .describe(
        "Names of secrets you were given (with request_secret or use_login) to pass to this command as environment variables. Only the ones named here reach it.",
      ),
  }),
  risk(args) {
    const badges: string[] = [];
    if (looksDestructive(args.command)) badges.push(BADGES.irreversible);
    if (looksSecuritySensitive(args.command)) badges.push(BADGES.security);
    // A command that is given secrets is always shown with them, so the user sees where each one goes.
    if (args.secrets?.length) badges.push(BADGES.secrets);
    const summary = args.secrets?.length
      ? `${args.command}\n(with your secrets: ${args.secrets.join(", ")})`
      : args.command;
    return { level: "ask", kind: "terminal", badges, summary };
  },
  async run(args, ctx) {
    // Only the secrets this command names, and only ones the bot was given: a later command doesn't receive them
    // just because they were granted once.
    const granted = ctx.env ?? {};
    const missing = (args.secrets ?? []).filter((name) => !(name in granted));
    if (missing.length > 0) {
      throw new Error(
        `You haven't been given ${missing.join(", ")}. Ask for it with request_secret (or use_login for a website's login) first.`,
      );
    }
    const env = Object.fromEntries((args.secrets ?? []).map((name) => [name, granted[name]!]));
    const cwd = resolvePath(ctx.workspace, args.cwd ?? ".").abs;
    await mkdir(cwd, { recursive: true });
    const result = await runShell(args.command, {
      cwd,
      timeoutMs: args.timeout_seconds * 1000,
      signal: ctx.signal,
      env,
    });
    return formatCommandResult(result, args.timeout_seconds);
  },
});

const fetchUrl = defineTool({
  name: "fetch_url",
  description:
    "Download a web page or API response and return it as readable text. Fast, but it doesn't run JavaScript: for shops, web apps and search boxes, use browser_open.",
  args: z.object({ url: z.url().describe("http(s) address") }),
  risk: (args) => addressRisk(args, args.url, `Fetch ${args.url}`),
  // A local address the user approved may be fetched; anything else must stay off the local network.
  run: (args, ctx) =>
    fetchReadable(args.url, ctx.signal, fetch, { allowPrivate: mayReachLocal(args, args.url) }),
});

const MAX_OPTIONS = 6;
const MAX_OPTION_LENGTH = 100;

/**
 * The choices a model wrote, as a clean list: it may send a real array, a JSON string of one, a bulleted or numbered
 * list in a string, or objects like {label}. Fewer than two usable choices is not a choice at all: undefined.
 */
export function cleanOptions(value: unknown): string[] | undefined {
  let list: unknown = value;
  if (typeof list === "string") {
    const text = list.trim();
    if (!text) return undefined;
    try {
      list = JSON.parse(text);
    } catch {
      // One per line. Not split on commas: a choice like "Paris, France" has one in it.
      list = text.split(/\r?\n/);
    }
  }
  if (!Array.isArray(list)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const raw =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? ["label", "text", "value", "name", "title"]
              .map((key) => (item as Record<string, unknown>)[key])
              .find((candidate): candidate is string => typeof candidate === "string")
          : typeof item === "number"
            ? String(item)
            : undefined;
    // Bullets and numbering a model puts in front of a line.
    const text = raw
      ?.trim()
      .replace(/^(?:[-*•]|\d{1,2}[.)])\s+/, "")
      .trim();
    if (!text || text.length > MAX_OPTION_LENGTH || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out.length >= 2 ? out.slice(0, MAX_OPTIONS) : undefined;
}

const askUser = defineTool({
  name: "ask_user",
  description:
    "Ask the user a short question and wait for the answer. Use only when you can't proceed without it. If the answer is one of a few known choices, pass them as options (2 to 6 short strings) so the user can tap one; set multiple to true to let them pick several. They can always type something else.",
  prepare: (args) => ({
    question: args.question,
    options: cleanOptions(args.options),
    multiple: args.multiple,
  }),
  args: z.object({
    question: z.string().min(1).max(1000),
    options: z.array(z.string().min(1).max(MAX_OPTION_LENGTH)).min(2).max(MAX_OPTIONS).optional(),
    multiple: z.boolean().optional(),
  }),
  risk: (args) => safe(args.question),
  run: async (args, ctx) => {
    const answer = await ctx.ask(args.question, { options: args.options, multiple: args.multiple });
    // Several picks come back one per line; listed one per line to the bot too, since a choice may contain a comma.
    return args.options && args.multiple
      ? `The user chose:\n${answer
          .split("\n")
          .map((line) => `- ${line}`)
          .join("\n")}`
      : `The user answered: ${answer}`;
  },
});

export const BUILTIN_TOOLS: ToolSpec[] = [
  listFiles,
  readFileTool,
  writeFileTool,
  editFile,
  searchFiles,
  runCommand,
  fetchUrl,
  askUser,
];
