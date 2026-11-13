import { posix } from "node:path";

/**
 * The deterministic part of the final check: plain code over the planned files, no model and no child process. It is
 * conservative on purpose: a finding sends good work back, so each rule only speaks when it is sure.
 */

export interface Finding {
  /** The planned file the problem is in. */
  file: string;
  problem: string;
  /** Other planned files the problem spans (the script a page loads, the pages a script looks in). */
  related?: string[];
}

export interface CheckInput {
  /** The planned files, as paths relative to the output folder with forward slashes. */
  files: string[];
  /** A file's text, or null when it isn't there. Any path inside the project may be asked for. */
  read(path: string): string | null;
}

const extensionOf = (path: string) => /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
const isHtml = (path: string) => ["html", "htm"].includes(extensionOf(path));
const isScript = (path: string) => ["js", "mjs", "jsx", "ts", "tsx"].includes(extensionOf(path));

/** Comments out of the way, so a commented-out import isn't taken for a real one. */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** Top-level `import` / `export` statements: what makes a file an ES module. */
const ES_MODULE_SYNTAX =
  /^[ \t]*(?:import\s*(?:[\w$*{][^"'\n;]*?\s*from\s*)?["'][^"'\n]+["']|import\s*\{|export\s+(?:default\b|(?:async\s+)?function\b|class\b|const\b|let\b|var\b|\{|\*))/m;

export const usesModuleSyntax = (source: string) => ES_MODULE_SYNTAX.test(withoutComments(source));

/** An attribute of a tag written as text (`src="x"`, `src='x'` or `src=x`). */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

/** A reference to a file in the project (not a web address, an anchor, a site-root path or a template). */
function localTarget(from: string, reference: string | null): string | null {
  const ref = reference?.trim().split(/[?#]/)[0] ?? "";
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//") || ref.startsWith("/")) return null;
  if (/\{\{|<%|\$\{/.test(ref)) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(from), ref));
  return resolved.startsWith("..") ? null : resolved;
}

const SCRIPT_SUFFIXES = ["", ".js", ".mjs", ".ts", ".jsx", ".tsx", "/index.js", "/index.mjs", "/index.ts"];

/** The file a relative import points at, trying the endings a bundler or Node would. */
function resolveImport(
  from: string,
  specifier: string,
  read: CheckInput["read"],
): { path: string; text: string } | null {
  const base = localTarget(from, specifier);
  if (!base) return null;
  for (const suffix of SCRIPT_SUFFIXES) {
    const text = read(`${base}${suffix}`);
    if (text !== null) return { path: `${base}${suffix}`, text };
  }
  return null;
}

/** The names a module exports, or null when it can't be told for sure (CommonJS, `export *`, destructured exports). */
function exportsOf(source: string): Set<string> | null {
  const code = withoutComments(source);
  if (/\bmodule\.exports\b|\bexports\.\w+\s*=|^[ \t]*export\s+\*/m.test(code)) return null;
  if (/^[ \t]*export\s+(?:const|let|var)\s*[{[]/m.test(code)) return null;
  const names = new Set<string>();
  for (const match of code.matchAll(
    /^[ \t]*export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([\w$]+)/gm,
  ))
    names.add(match[1]!);
  for (const match of code.matchAll(/^[ \t]*export\s*\{([^}]*)\}/gm))
    for (const part of match[1]!.split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (name) names.add(name);
    }
  if (/^[ \t]*export\s+default\b/m.test(code)) names.add("default");
  return names;
}

/** What an import clause asks for: `{ a, b as c }`, `d`, `d, { a }`; a namespace import asks for nothing in particular. */
function importedNames(clause: string): string[] {
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces)
    for (const part of braces[1]!.split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.push(name);
    }
  const outside = clause.replace(/\{[^}]*\}/, "").replace(/\*\s*as\s+[\w$]+/, "");
  if (/[\w$]+/.test(outside)) names.push("default");
  return names;
}

const SECRET =
  /\b(api[_-]?key|apikey|access[_-]?key|auth[_-]?token|token|secret|password|passwd)\b["']?\s*[:=]\s*["']([A-Za-z0-9]{20,})["']/gi;
const MARKED_PLACEHOLDER = /YOUR|PLACEHOLDER|REPLACE|XXX|[<>]/i;

/** Every check, over the planned files. */
export function checkProject({ files, read }: CheckInput): Finding[] {
  const findings: Finding[] = [];
  const found = (finding: Finding) => {
    if (!findings.some((other) => other.file === finding.file && other.problem === finding.problem))
      findings.push(finding);
  };
  const texts = new Map(files.map((file) => [file, read(file)]));
  const planned = (path: string) => files.find((file) => file.toLowerCase() === path.toLowerCase());

  for (const file of files) {
    const text = texts.get(file);
    if (text === null || text === undefined) continue;

    if (isHtml(file)) {
      for (const tag of text.matchAll(/<script\b[^>]*>/gi)) {
        const src = attribute(tag[0], "src");
        const target = localTarget(file, src);
        if (!target) continue;
        const script = read(target);
        if (script === null) {
          found({
            file,
            problem: `${file} loads ${src} with a <script> tag, but there is no such file.`,
            related: planned(target) ? [planned(target)!] : undefined,
          });
        } else if ((attribute(tag[0], "type") ?? "").toLowerCase() !== "module" && usesModuleSyntax(script)) {
          found({
            file,
            problem: `${file} loads ${target} with a plain <script src="${src}"> tag, but ${target} uses import/export, which only works in a module script. Add type="module" to the tag, or take the import/export out of ${target}.`,
            related: [planned(target) ?? target],
          });
        }
      }
      for (const [pattern, name, what] of [
        [/<link\b[^>]*>/gi, "href", "<link>"],
        [/<img\b[^>]*>/gi, "src", "<img>"],
      ] as const)
        for (const tag of text.matchAll(pattern)) {
          const reference = attribute(tag[0], name);
          const target = localTarget(file, reference);
          if (target && read(target) === null)
            found({
              file,
              problem: `${file} has a ${what} pointing at ${reference}, but there is no such file.`,
              related: planned(target) ? [planned(target)!] : undefined,
            });
        }
    }

    if (isScript(file)) {
      const code = withoutComments(text);
      const check = (specifier: string, names: string[]) => {
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) return;
        const target = resolveImport(file, specifier, read);
        if (!target) {
          found({
            file,
            problem: `${file} imports ${specifier}, but there is no such file.`,
          });
          return;
        }
        if (!isScript(target.path) || names.length === 0) return;
        const exported = exportsOf(target.text);
        const missing = exported ? names.filter((name) => !exported.has(name)) : [];
        if (missing.length > 0)
          found({
            file,
            problem: `${file} imports ${missing.map((name) => (name === "default" ? "the default export" : name)).join(", ")} from ${specifier}, but ${target.path} doesn't export ${missing.length === 1 ? "it" : "them"}.`,
            related: planned(target.path) ? [planned(target.path)!] : undefined,
          });
      };
      for (const match of code.matchAll(/^[ \t]*import\s+([^"'\n;]*?)\s*from\s*["']([^"']+)["']/gm))
        check(match[2]!, importedNames(match[1]!));
      for (const match of code.matchAll(/^[ \t]*import\s*["']([^"']+)["']/gm)) check(match[1]!, []);
      for (const match of code.matchAll(
        /^[ \t]*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{([^}]*)\})\s*from\s*["']([^"']+)["']/gm,
      ))
        check(match[2]!, match[1] ? importedNames(`{${match[1]}}`) : []);
    }

    if (extensionOf(file) === "json") {
      try {
        JSON.parse(text);
      } catch (error) {
        found({ file, problem: `${file} is not valid JSON (${(error as Error).message}).` });
      }
    }

    if (isScript(file) || isHtml(file) || ["json", "env", "py"].includes(extensionOf(file))) {
      for (const match of text.matchAll(SECRET)) {
        if (MARKED_PLACEHOLDER.test(match[2]!)) continue;
        found({
          file,
          problem: `${file} has a ${match[1]} that looks like a real key (“${match[2]!.slice(0, 6)}…”). Never invent keys: use a clearly marked placeholder such as YOUR_API_KEY_HERE, with a comment saying where to get one.`,
        });
      }
    }
  }

  // Element ids a script looks for must exist in some page of the project: only ids, classes are too noisy.
  const pages = files.filter(isHtml).filter((file) => texts.get(file) !== null);
  if (pages.length > 0) {
    const sources = files.map((file) => texts.get(file) ?? "").join("\n");
    // A script that builds ids at run time could make any id: then nothing can be said for sure.
    const dynamic =
      /\.id\s*=\s*(?!["'])|setAttribute\(\s*["']id["']\s*,\s*(?!["'])|\bid\s*=\s*["'][^"']*\$\{/.test(
        sources,
      );
    if (!dynamic) {
      const declared = new Set<string>();
      for (const pattern of [
        /\bid\s*=\s*["']([\w-]+)["']/g,
        /\.id\s*=\s*["']([\w-]+)["']/g,
        /setAttribute\(\s*["']id["']\s*,\s*["']([\w-]+)["']/g,
        /\bid\s*:\s*["']([\w-]+)["']/g,
      ])
        for (const match of sources.matchAll(pattern)) declared.add(match[1]!);
      for (const file of files.filter(isScript)) {
        const code = withoutComments(texts.get(file) ?? "");
        const wanted = new Set<string>();
        for (const match of code.matchAll(/getElementById\(\s*["']([\w-]+)["']\s*\)/g)) wanted.add(match[1]!);
        for (const match of code.matchAll(/querySelector(?:All)?\(\s*["']#([\w-]+)["']\s*\)/g))
          wanted.add(match[1]!);
        for (const id of wanted)
          if (!declared.has(id))
            found({
              file,
              problem: `${file} looks for the element with id "${id}", but no page in the project has id="${id}".`,
              related: pages,
            });
      }
    }
  }

  return findings;
}

/** The ends of a placeholder written for the user to fill in (YOUR_API_KEY_HERE), as words ("API key"). */
const PLACEHOLDER = /\bYOUR_[A-Z0-9_]+\b|\bREPLACE_[A-Z0-9_]+\b|\b[A-Z0-9_]*PLACEHOLDER[A-Z0-9_]*\b/g;
const ACRONYMS = new Set(["api", "url", "id", "ui", "sdk", "ip", "db"]);

function describePlaceholder(token: string): string {
  const words = token
    .replace(/^(?:YOUR|REPLACE)_(?:WITH_)?/, "")
    .replace(/_(?:HERE|ME)$/, "")
    .split("_")
    .filter(Boolean)
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()));
  return words.join(" ") || "value";
}

/** What to do before running the finished project, from what is in the files. Empty when there is nothing to say. */
export function beforeYouRun({ files, read }: CheckInput): string[] {
  const lines: string[] = [];
  let browser = false;
  let modules = false;
  for (const file of files) {
    const text = read(file);
    if (text === null) continue;
    for (const token of new Set(text.match(PLACEHOLDER) ?? [])) {
      const line = `add your own ${describePlaceholder(token)} in ${file}`;
      if (!lines.includes(line)) lines.push(line);
    }
    if (isHtml(file)) {
      browser = true;
      if (/<script\b[^>]*\btype\s*=\s*["']?module/i.test(text)) modules = true;
    } else if (isScript(file) && usesModuleSyntax(text)) modules = true;
  }
  if (browser && modules)
    lines.push(
      "open it through a local web server (for example run `python -m http.server` in the folder), not by double-clicking the file",
    );
  return lines;
}
