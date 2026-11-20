import type { CodingEdge, CodingNode } from "@mrog/shared";

import {
  attribute,
  exportsOf,
  extensionOf,
  importedNames,
  isHtml,
  isScript,
  idsOnPage,
  localTarget,
  markupOf,
  resolveImport,
  topLevelNames,
  usesModuleSyntax,
  withoutComments,
  withoutHtmlComments,
  type CheckInput,
} from "./coding-check";

export { duplicateIds } from "./coding-check";

/**
 * The contract between a project's files, read from their code as it is written, not from the plan's prose: the ids
 * and classes a page has, what it loads, what a script exports and imports, the ids and classes it uses, the classes a
 * stylesheet styles. A small model told "the page has #moviesGrid and .movie-card" uses those exact names; told a
 * paragraph of plan, it guesses. When the code and the plan disagree, the code is what runs, so the code wins.
 */

export type FileKind = "data" | "page" | "script" | "style" | "other";

export interface FileContract {
  path: string;
  kind: FileKind;
  /** Element ids a page has, or a script looks up. */
  ids: string[];
  /** Classes a page uses, a script uses or creates, or a stylesheet styles. */
  classes: string[];
  /** Planned files a page loads (scripts, stylesheets). */
  loads: string[];
  /** What a script exports (null: can't be told for sure). */
  exports: string[] | null;
  /** What a script imports from other planned files. */
  imports: { from: string; names: string[] }[];
  /** What a plain script (no import/export) defines for the others on its page: top-level names, window.X. */
  globals: string[];
}

/** A connection read from the code: directed and typed, from the file that uses to the file that provides. */
export interface Link {
  from: string;
  to: string;
  kind: "loads" | "imports";
  names: string[];
}

const STYLE_EXTENSIONS = new Set(["css", "scss", "sass", "less"]);
const DOC_EXTENSIONS = new Set(["md", "markdown", "txt", "rst"]);

/** What kind of file a path is, by name: what decides its place in the build order. */
export function kindOf(path: string): FileKind {
  const extension = extensionOf(path);
  const name = (path.split("/").at(-1) ?? "").toLowerCase();
  if (isHtml(path)) return "page";
  if (STYLE_EXTENSIONS.has(extension)) return "style";
  // Data and settings other files read: written first, so they can be read.
  if (extension === "json" || /config|settings/.test(name.replace(/\.[^.]+$/, ""))) return "data";
  if (DOC_EXTENSIONS.has(extension) || name === "license" || name === "readme") return "other";
  return "script";
}

/**
 * Build order: data and settings, then pages (the skeleton: they define the ids and classes everything else uses),
 * then scripts (they look up the page's ids and create elements with classes no page has), then styles (written last,
 * so they can style the classes the scripts make too), then docs. The Planner's order is kept within each kind.
 */
const RANK: Record<FileKind, number> = { data: 0, page: 1, script: 2, style: 3, other: 4 };
export function buildOrder<T>(items: readonly T[], pathOf: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, rank: RANK[kindOf(pathOf(item))] }))
    .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}

const unique = (values: Iterable<string>) => [...new Set(values)];

/** The endings an import may leave off, to find the planned file it means before that file is written. */
const PLANNED_SUFFIXES = ["", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", "/index.js", "/index.ts"];

function classesOnPage(html: string): string[] {
  const classes: string[] = [];
  for (const match of markupOf(html).matchAll(/<[a-z][^>]*?\sclass\s*=\s*["']([^"']*)["']/gi))
    classes.push(...match[1]!.split(/\s+/).filter((name) => /^-?[A-Za-z_][\w-]*$/.test(name)));
  return unique(classes);
}

/** The ids a script looks up, and the classes it looks for, adds or writes into markup it builds. */
function scriptNames(code: string): { ids: string[]; classes: string[] } {
  const ids = new Set<string>();
  const classes = new Set<string>();
  for (const match of code.matchAll(/getElementById\(\s*["'`]([\w-]+)["'`]\s*\)/g)) ids.add(match[1]!);
  for (const match of code.matchAll(/querySelector(?:All)?\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    for (const id of match[1]!.matchAll(/#([A-Za-z_][\w-]*)/g)) ids.add(id[1]!);
    for (const name of match[1]!.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) classes.add(name[1]!);
  }
  for (const match of code.matchAll(/getElementsByClassName\(\s*["'`]([\w\s-]+)["'`]\s*\)/g))
    for (const name of match[1]!.split(/\s+/)) if (name) classes.add(name);
  for (const match of code.matchAll(/classList\.(?:add|remove|toggle|contains|replace)\(([^)]*)\)/g))
    for (const name of match[1]!.matchAll(/["'`]([\w-]+)["'`]/g)) classes.add(name[1]!);
  for (const match of code.matchAll(/\bclassName\s*=\s*["'`]([^"'`$]*)["'`]/g))
    for (const name of match[1]!.split(/\s+/)) if (/^-?[A-Za-z_][\w-]*$/.test(name)) classes.add(name);
  // Markup a script writes: class="…" inside a string or template.
  for (const match of code.matchAll(/\bclass\s*=\s*\\?["']([^"'$\\]*)\\?["']/g))
    for (const name of match[1]!.split(/\s+/)) if (/^-?[A-Za-z_][\w-]*$/.test(name)) classes.add(name);
  return { ids: [...ids], classes: [...classes] };
}

/**
 * The names a CommonJS file exports: the keys of `module.exports = { a, b: c, d() {} }` and every `exports.x =` /
 * `module.exports.x =`. Null when there are none to read for sure (`module.exports = someFunction`).
 */
export function commonJsExports(code: string): Set<string> | null {
  const names = new Set<string>();
  const object = /\bmodule\.exports\s*=\s*\{([^}]*)\}/.exec(code);
  if (object)
    for (const part of object[1]!.split(",")) {
      const name = part.trim().split(/[\s:(]/)[0]!;
      if (/^[\w$]+$/.test(name)) names.add(name);
    }
  for (const match of code.matchAll(/\b(?:module\.)?exports\.([\w$]+)\s*=(?!=)/g)) names.add(match[1]!);
  return names.size > 0 ? names : null;
}

/** The classes and ids a stylesheet styles, read from its selectors (not its values: no colours, no file names). */
function styleNames(css: string): { ids: string[]; classes: string[] } {
  const ids = new Set<string>();
  const classes = new Set<string>();
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of plain.matchAll(/([^{}]+)\{/g)) {
    const selector = match[1]!.trim();
    if (selector.startsWith("@")) continue;
    for (const name of selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) classes.add(name[1]!);
    for (const id of selector.matchAll(/#([A-Za-z_][\w-]*)/g)) ids.add(id[1]!);
  }
  return { ids: [...ids], classes: [...classes] };
}

/** Each planned file's contract, from its code; files not written yet are left out. And the links between them. */
export function readContract({ files, read }: Pick<CheckInput, "files" | "read">): {
  files: Map<string, FileContract>;
  links: Link[];
} {
  const contracts = new Map<string, FileContract>();
  const links: Link[] = [];
  const planned = (path: string) => files.find((file) => file.toLowerCase() === path.toLowerCase());
  for (const path of files) {
    const text = read(path);
    if (text === null) continue;
    const kind = kindOf(path);
    const contract: FileContract = {
      path,
      kind,
      ids: [],
      classes: [],
      loads: [],
      exports: null,
      imports: [],
      globals: [],
    };
    if (kind === "page") {
      contract.ids = unique(idsOnPage(text));
      contract.classes = classesOnPage(text);
      const page = withoutHtmlComments(text);
      // Scripts and stylesheets in the order the page has them.
      const references = [...page.matchAll(/<(script|link)\b[^>]*>/gi)].map((tag) =>
        attribute(tag[0], tag[1]!.toLowerCase() === "script" ? "src" : "href"),
      );
      for (const reference of references) {
        const target = localTarget(path, reference);
        const file = target && planned(target);
        if (file && !contract.loads.includes(file)) {
          contract.loads.push(file);
          links.push({ from: path, to: file, kind: "loads", names: [] });
        }
      }
    } else if (kind === "style") {
      Object.assign(contract, styleNames(text));
    } else if (isScript(path) || kind === "script") {
      const code = withoutComments(text);
      Object.assign(contract, scriptNames(code));
      // ES modules, or CommonJS (`module.exports = { … }`, `exports.x = …`) for Node code written the older way.
      const exported = isScript(path) ? (exportsOf(text) ?? commonJsExports(code)) : null;
      contract.exports = exported ? [...exported] : null;
      // A plain script shares what it declares at the top level, and what it puts on window, with the page's others.
      if (isScript(path) && !usesModuleSyntax(text) && (!exported || exported.size === 0))
        contract.globals = unique([
          ...topLevelNames(code),
          ...[...code.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map((match) => match[1]!),
        ]);
      const imported = (specifier: string, names: string[]) => {
        // A file on disk, or one the plan has that isn't written yet (what it must export is what this asks for).
        const written = resolveImport(path, specifier, read);
        const base = localTarget(path, specifier);
        const file = written
          ? planned(written.path)
          : base
            ? PLANNED_SUFFIXES.map((suffix) => planned(`${base}${suffix}`)).find(Boolean)
            : undefined;
        if (!file || contract.imports.some((entry) => entry.from === file)) return;
        contract.imports.push({ from: file, names });
        links.push({ from: path, to: file, kind: "imports", names });
      };
      for (const match of code.matchAll(/^[ \t]*import\s+([^"'\n;]*?)\s*from\s*["']([^"']+)["']/gm))
        imported(match[2]!, importedNames(match[1]!));
      // `const { a, b: c } = require("./x")` asks for a and b; a plain `require("./x")` for nothing in particular.
      for (const match of code.matchAll(
        /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g,
      ))
        imported(
          match[2]!,
          match[1]!
            .split(",")
            .map((part) => part.trim().split(/\s*:\s*/)[0]!)
            .filter((name) => /^[\w$]+$/.test(name)),
        );
      for (const match of code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) imported(match[1]!, []);
    }
    contracts.set(path, contract);
  }
  return { files: contracts, links };
}

/** At most `max` names, then how many more: short enough for a small model to take in. */
const list = (names: string[], max: number) =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;

const ids = (names: string[], max: number) =>
  list(
    names.map((name) => `#${name}`),
    max,
  );
const classes = (names: string[], max: number) =>
  list(
    names.map((name) => `.${name}`),
    max,
  );

/**
 * What a file's card should be told about the files around it, read from their code: the exact names to use. Null
 * when nothing that touches it is written yet. `max` caps each list.
 */
export function contractFor(
  path: string,
  contract: { files: Map<string, FileContract>; links: Link[] },
  max = 30,
): string | null {
  const kind = kindOf(path);
  const others = [...contract.files.values()].filter((other) => other.path !== path);
  const lines: string[] = [];
  const pages = others.filter((other) => other.kind === "page");
  const scripts = others.filter((other) => other.kind === "script");
  // Code, whatever its place in the build order: a settings file like api-config.js is a script too.
  const code = kind === "script" || (kind === "data" && isScript(path));

  if (code) {
    // The pages that load this script, or every page while none does yet.
    const loading = pages.filter((page) => page.loads.includes(path));
    if (kind === "script")
      for (const page of loading.length > 0 ? loading : pages) {
        if (page.ids.length > 0) lines.push(`- ${page.path} has the ids: ${ids(page.ids, max)}`);
        if (page.classes.length > 0)
          lines.push(`- ${page.path} uses the classes: ${classes(page.classes, max)}`);
      }
    // What the other code exports, settings files included, and what the plain scripts define for the page.
    for (const other of others) {
      if (other.exports && other.exports.length > 0)
        lines.push(`- ${other.path} exports: ${list(other.exports, max)}`);
      if (other.globals.length > 0)
        lines.push(
          `- ${other.path} defines (shared with the page's other scripts): ${list(other.globals, max)}`,
        );
    }
    // Who already imports from this file. Only while it isn't written: the file written first is the contract, so
    // once this one exists, the files importing from it are told its real exports and adapt, not the other way round.
    if (!contract.files.has(path))
      for (const other of others)
        for (const entry of other.imports)
          if (entry.from === path && entry.names.length > 0)
            lines.push(
              `- ${other.path} imports from this file: ${list(entry.names, max)} (export exactly these names)`,
            );
  } else if (kind === "page") {
    for (const script of scripts) {
      if (script.ids.length > 0) lines.push(`- ${script.path} looks up the ids: ${ids(script.ids, max)}`);
      if (script.classes.length > 0)
        lines.push(`- ${script.path} uses the classes: ${classes(script.classes, max)}`);
    }
  } else if (kind === "style") {
    for (const page of pages) {
      if (page.ids.length > 0) lines.push(`- ${page.path} has the ids: ${ids(page.ids, max)}`);
      if (page.classes.length > 0)
        lines.push(`- ${page.path} uses the classes: ${classes(page.classes, max)}`);
    }
    for (const script of scripts)
      if (script.classes.length > 0)
        lines.push(
          `- ${script.path} uses or creates the classes: ${classes(script.classes, max)} (style these too)`,
        );
  }
  if (lines.length === 0) return null;
  return [
    "Exact names, read from the code of the files already written. Use these names; where the plan's descriptions say otherwise, the code is right:",
    ...lines,
  ].join("\n");
}

/**
 * The links read from the code as the diagram draws connections: one per pair of files, from the file that uses to
 * the file that provides, with what passes between them. Ids start with "c" so they never mix with the plan's "e…".
 */
export function linksAsEdges(links: readonly Link[], nodes: readonly CodingNode[]): CodingEdge[] {
  const idOf = (path: string) => nodes.find((node) => node.path === path)?.id;
  const edges: CodingEdge[] = [];
  for (const link of links) {
    const from = idOf(link.from);
    const to = idOf(link.to);
    if (!from || !to || from === to) continue;
    if (edges.some((edge) => edge.files[0] === from && edge.files[1] === to)) continue;
    const description =
      link.kind === "loads"
        ? `${link.from} loads ${link.to}`
        : link.names.length > 0
          ? `${link.from} imports ${link.names.join(", ")} from ${link.to}`
          : `${link.from} imports ${link.to}`;
    edges.push({ id: `c${edges.length + 1}`, files: [from, to], description });
  }
  return edges;
}
