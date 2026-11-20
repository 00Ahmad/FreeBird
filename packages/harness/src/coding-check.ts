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
  /**
   * What the user wrote (the brief): a key that appears in it was given, not made up, so the key check leaves it alone.
   * The project then works; keeping it out of the code is a separate matter.
   */
  given?: string;
}

export const extensionOf = (path: string) => /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
const nameOf = (path: string) => (path.split("/").at(-1) ?? "").toLowerCase();
export const isHtml = (path: string) => ["html", "htm"].includes(extensionOf(path));
export const isScript = (path: string) =>
  ["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"].includes(extensionOf(path));

/** Pictures, icons, fonts, sound and video: files the Developer can't write, so a missing one is the user's to add. */
const MEDIA = new Set(
  "png jpg jpeg gif webp avif bmp ico svg tif tiff heic woff woff2 ttf otf eot mp3 wav ogg oga m4a aac flac mp4 webm mov m4v avi mkv pdf".split(
    " ",
  ),
);
/** What a page may point at that the Developer writes: one of these that isn't there is a real gap. */
const WRITTEN = new Set(["js", "mjs", "cjs", "css", "html", "htm", "json"]);
/** Files that aren't text, which the key check skips. */
const BINARY = new Set([
  ...MEDIA,
  ..."zip gz tgz 7z rar exe dll so dylib wasm bin class jar pyc db sqlite".split(" "),
]);

/** Comments out of the way, so a commented-out import isn't taken for a real one. */
export const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** A page without its <!-- comments -->, found with indexOf so an unclosed one costs one pass (it hides the rest). */
export function withoutHtmlComments(html: string): string {
  let kept = "";
  let at = 0;
  for (;;) {
    const open = html.indexOf("<!--", at);
    if (open === -1) return kept + html.slice(at);
    kept += html.slice(at, open);
    const close = html.indexOf("-->", open + 4);
    if (close === -1) return kept;
    at = close + 3;
  }
}

/** A page's markup with what isn't markup taken out: comments, scripts, styles and templates. */
export function markupOf(html: string): string {
  return withoutHtmlComments(html)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<template\b[\s\S]*?<\/template\s*>/gi, "");
}

/** Every id written on a page's markup, in order, repeats included. */
export function idsOnPage(html: string): string[] {
  return [...markupOf(html).matchAll(/<[a-z][^>]*?\sid\s*=\s*["']([\w-]+)["']/gi)].map((match) => match[1]!);
}

/** The ids written more than once on one page (an id must be unique on its page). */
export function duplicateIds(html: string): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const id of idsOnPage(html)) (seen.has(id) ? twice : seen).add(id);
  return [...twice];
}

/** Top-level `import` / `export` statements: what makes a file an ES module. */
const ES_MODULE_SYNTAX =
  /^[ \t]*(?:import\s*(?:[\w$*{][^"'\n;]*?\s*from\s*)?["'][^"'\n]+["']|import\s*\{|export\s+(?:default\b|(?:async\s+)?function\b|class\b|const\b|let\b|var\b|\{|\*))/m;

export const usesModuleSyntax = (source: string) => ES_MODULE_SYNTAX.test(withoutComments(source));

/** An attribute of a tag written as text (`src="x"`, `src='x'` or `src=x`); `data-src` is another attribute. */
export function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

/** A reference to a file in the project (not a web address, an anchor, a site-root path or a template). */
export function localTarget(from: string, reference: string | null): string | null {
  const ref = reference?.trim().split(/[?#]/)[0] ?? "";
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//") || ref.startsWith("/")) return null;
  if (/\{\{|<%|\$\{/.test(ref)) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(from), ref));
  return resolved.startsWith("..") ? null : resolved;
}

const SCRIPT_SUFFIXES = [
  "",
  ".js",
  ".mjs",
  ".ts",
  ".jsx",
  ".tsx",
  ".mts",
  "/index.js",
  "/index.mjs",
  "/index.ts",
  "/index.tsx",
];
/** TypeScript with NodeNext imports `./b.js` for the file b.ts: the import names what the build will write. */
const SOURCE_FOR: Record<string, string[]> = { js: ["ts", "tsx"], jsx: ["tsx"], mjs: ["mts"], cjs: ["cts"] };

/** The file a relative import points at, trying the endings a bundler or Node would. */
export function resolveImport(
  from: string,
  specifier: string,
  read: CheckInput["read"],
): { path: string; text: string } | null {
  const base = localTarget(from, specifier);
  if (!base) return null;
  const extension = extensionOf(base);
  const stem = base.slice(0, base.length - extension.length - 1);
  for (const path of [
    ...SCRIPT_SUFFIXES.map((suffix) => `${base}${suffix}`),
    ...(SOURCE_FOR[extension] ?? []).map((source) => `${stem}.${source}`),
  ]) {
    const text = read(path);
    if (text !== null) return { path, text };
  }
  return null;
}

/** The names a module exports, or null when it can't be told for sure (CommonJS, `export *`, destructured exports). */
export function exportsOf(source: string): Set<string> | null {
  const code = withoutComments(source);
  if (/\bmodule\.exports\b|\bexports\.\w+\s*=|^[ \t]*export\s*(?:\*|=|import\b|as\s+namespace\b)/m.test(code))
    return null;
  if (/^[ \t]*export\s+(?:declare\s+)?(?:const|let|var)\s*[{[]/m.test(code)) return null;
  const names = new Set<string>();
  // TypeScript's own exports too: types, interfaces, enums, namespaces, abstract and declared ones.
  for (const match of code.matchAll(
    /^[ \t]*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\b\s*\*?\s*|(?:class|const\s+enum|const|let|var|type|interface|enum|namespace|module)\s+)([\w$]+)/gm,
  ))
    names.add(match[1]!);
  for (const match of code.matchAll(/^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}/gm))
    for (const part of match[1]!.split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (name) names.add(name);
    }
  if (/^[ \t]*export\s+default\b/m.test(code)) names.add("default");
  return names;
}

/**
 * What an import clause asks for: `{ a, b as c }`, `d`, `d, { a }`; a namespace import asks for nothing in particular.
 * Types (`import type …`, `{ type T }`) are left out: they don't exist when the code runs, and TypeScript checks them.
 */
export function importedNames(clause: string): string[] {
  if (/^type\s+[\w${*]/.test(clause.trim())) return [];
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces)
    for (const part of braces[1]!.split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name && !/^type\s/.test(name)) names.push(name);
    }
  const outside = clause.replace(/\{[^}]*\}/, "").replace(/\*\s*as\s+[\w$]+/, "");
  if (/[\w$]+/.test(outside)) names.push("default");
  return names;
}

/**
 * JSON files that tools read with comments and trailing commas allowed (JSONC): tsconfig.json and its kin, editor
 * settings, *.jsonc.
 */
const isJsonc = (path: string) =>
  extensionOf(path) === "jsonc" ||
  /^(?:[tj]sconfig(?:\.[\w.-]+)?|\.eslintrc|devcontainer)\.json$/.test(nameOf(path)) ||
  /(?:^|\/)\.vscode\/[^/]+\.json$/i.test(path);

/**
 * JSONC as plain JSON: comments and trailing commas become spaces (so an error's position still points at the
 * file), and what is inside strings stays as it is ("@/*" in tsconfig's paths is not a comment).
 */
function plainJson(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
  };
  let lastComma = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      lastComma = -1;
    } else if (char === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      blank(i, end === -1 ? text.length : end + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (char === ",") lastComma = i;
    else if (char === "}" || char === "]") {
      if (lastComma !== -1) out[lastComma] = " ";
      lastComma = -1;
    } else if (!/\s/.test(char!)) lastComma = -1;
  }
  return out.join("");
}

// ---- made-up keys ------------------------------------------------------------------------------------------------

const NEVER_INVENT =
  "Never invent keys: use a clearly marked placeholder such as YOUR_API_KEY_HERE, with a comment saying where to get one.";

/** The words of a name: `OPENWEATHER_API_KEY`, `appKey`, `client-secret`, `auth token`. */
const wordsOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const SECRET_WORDS = new Set(
  "secret secrets password passwd pwd passphrase credential credentials apikey appkey appid token auth authorization bearer privatekey accesskey secretkey".split(
    " ",
  ),
);
/** Names that hold a hash, an id or a lookup key, never a secret: fileHash, userId, STORAGE_KEY, publicKey. */
const NOT_SECRET_WORDS = new Set(
  "hash checksum digest md5 uuid guid id ids etag integrity idempotency cache storage sort primary foreign public".split(
    " ",
  ),
);
/** A secret's name doesn't end with what describes it: tokenUrl, passwordHint, keyName. */
const NOT_SECRET_ENDS = new Set(
  "url uri endpoint path file name type length size expiry expires header field label hint prefix count index domain host hostname provider method mode scheme server service realm scope version audience issuer region bucket".split(
    " ",
  ),
);

function isSecretName(name: string): boolean {
  const words = wordsOf(name);
  const last = words.at(-1);
  if (!last || NOT_SECRET_ENDS.has(last)) return false;
  if (words.some((word) => NOT_SECRET_WORDS.has(word) || /^sha\d*$/.test(word))) return false;
  return last === "key" || last === "keys" || words.some((word) => SECRET_WORDS.has(word));
}

/** How mixed the characters are, in bits per character: a key is near 4 or more, a word is lower. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / text.length) * Math.log2(count / text.length);
  return bits;
}

/** Whether one piece of a value reads as words: weather, favoriteCities, weatherAppFavoriteCities2024, v2, 2024. */
function wordy(part: string): boolean {
  if (/^(?:[A-Za-z]{1,12}|\d{1,4}|v\d+)$/i.test(part)) return true;
  const pieces = part.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [];
  if (pieces.join("") !== part) return false;
  const letters = part.replace(/\d/g, "").length;
  return (
    letters >= 2 * (part.length - letters) &&
    pieces.every((piece) => /^\d{1,4}$/.test(piece) || piece.length >= 3)
  );
}

/**
 * Whether a value looks like a generated key: long, of the characters keys use, with digits (or both cases), well
 * mixed, and not words (weather-app-favorite-cities or weatherAppFavoriteCities2024 is a name, not a key).
 */
function looksRandom(value: string): boolean {
  if (value.length < 16 || value.length > 512 || !/^[A-Za-z0-9_\-/+=.~]+$/.test(value)) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  if (
    value
      .split(/[-_./+=~]+/)
      .filter(Boolean)
      .every(wordy)
  )
    return false;
  if (!/\d/.test(value) && !(/[a-z]/.test(value) && /[A-Z]/.test(value) && value.length >= 24)) return false;
  return entropy(value) >= 3;
}

/** A marker word on its own (YOUR_API_KEY, your-key, yourApiKey), not letters that happen to be inside a key. */
const PLACEHOLDER_WORD =
  /(?:^|[^a-z0-9])(?:your|placeholder|changeme|change_me|replace_?me|example|dummy|sample|fake|redacted|notarealkey|not_a_real_(?:key|token|secret)|insert|paste|here)(?:$|[^a-z0-9])/i;

/** Whether a value is clearly a stand-in for the user's own key. */
function isPlaceholder(value: string): boolean {
  if (
    /^(?:your|my|replace|insert|enter|paste|put|placeholder|changeme|example|dummy|sample|fake|test|demo)/i.test(
      value,
    )
  )
    return true;
  if (/[<>]|\.\.\.|…|x{3,}|\*{3}|^(.)\1+$/i.test(value)) return true;
  return PLACEHOLDER_WORD.test(value.replace(/([a-z])([A-Z])/g, "$1_$2").replaceAll("-", "_"));
}

/**
 * A value given to a name, in the forms code and config use: `name = "v"`, `name: 'v'`, `"name": "v"`, `name := "v"`,
 * `'name' => 'v'`, `name: string = "v"`, `$env:NAME = "v"`, with ", ' or ` quotes.
 */
const ASSIGNED =
  /(?:(["'`])([A-Za-z_$][\w$ .-]{0,60}?)\1|(?:\$env:)?((?<![\w$.-])[A-Za-z_$][\w$.-]{0,60}))(?:[ \t]*:[ \t]*[A-Za-z_$][\w$.<>[\]]{0,40})?[ \t]*(?::=|=>|=(?![=>])|:(?!:))[ \t]*(["'`])([^"'`\s\\]{8,512})\4/g;
/** A line of a .env, .ini, .properties, YAML or TOML file, whose values need no quotes: `API_KEY=abc`. */
const CONFIG_LINE =
  /^[ \t]*(?:export[ \t]+|-[ \t]+)?([A-Za-z_][\w.-]*)[ \t]*[:=][ \t]*([^\s"'`#;]+)[ \t]*(?:[#;].*)?$/gm;
const isConfigFile = (path: string) =>
  /^\.env(?:\..+)?$|\.env$/.test(nameOf(path)) ||
  ["ini", "properties", "yaml", "yml", "toml", "cfg", "conf"].includes(extensionOf(path));
/** Keys whose start says what they are, wherever they appear (not inside a longer word or a base64 run). */
const KNOWN_KEY =
  /(?<![A-Za-z0-9+/_=-])(sk-(?:proj-|ant-)?|sk_(?:live|test)_|pk_(?:live|test)_|rk_(?:live|test)_|gh[pousr]_|github_pat_|xox[abposr]-|AKIA|ASIA|AIza)([A-Za-z0-9_-]{16,})/g;
const BEARER = /\bBearer[ \t]+([A-Za-z0-9_\-.=+/]{16,})/g;
/** A key in a web address's query: `?appid=…`, `&api_key=…`, `&token=…`. */
const KEY_IN_ADDRESS =
  /[?&](appid|api[_-]?key|apikey|key|token|access[_-]?token|auth|client[_-]?secret|secret|password)=([^&#\s"'`<>]+)/gi;

/** The made-up keys in one file's text. */
function keysIn(file: string, text: string, given = ""): Finding[] {
  const found: Finding[] = [];
  // One finding per key, however many of the patterns below see it.
  const seen = new Set<string>();
  const add = (key: string, problem: string) => {
    // A key the user gave (in the brief) was copied, not invented.
    if (seen.has(key) || (key.length >= 8 && given.includes(key))) return;
    seen.add(key);
    found.push({ file, problem: `${problem} ${NEVER_INVENT}` });
  };
  const named = (name: string, value: string) => {
    if (isSecretName(name) && !isPlaceholder(value) && looksRandom(value))
      add(value, `${file} has a ${name.trim()} that looks like a real key (“${value.slice(0, 6)}…”).`);
  };
  for (const match of text.matchAll(ASSIGNED)) named(match[2] ?? match[3]!, match[5]!);
  if (isConfigFile(file)) for (const match of text.matchAll(CONFIG_LINE)) named(match[1]!, match[2]!);
  for (const match of text.matchAll(KNOWN_KEY)) {
    const key = `${match[1]}${match[2]}`;
    // AWS and Google keys have an exact shape, which says more than how mixed they look.
    const shaped = /^(?:A[KS]IA[0-9A-Z]{16}|AIza[\w-]{35})$/.test(key);
    if (!isPlaceholder(key) && !isPlaceholder(match[2]!) && (shaped || looksRandom(match[2]!)))
      add(key, `${file} has what looks like a real key (“${key.slice(0, 6)}…”).`);
  }
  for (const match of text.matchAll(BEARER))
    if (!isPlaceholder(match[1]!) && looksRandom(match[1]!))
      add(match[1]!, `${file} has what looks like a real token after Bearer (“${match[1]!.slice(0, 6)}…”).`);
  for (const match of text.matchAll(KEY_IN_ADDRESS))
    if (!isPlaceholder(match[2]!) && looksRandom(match[2]!))
      add(match[2]!, `${file} has a key in a web address (${match[1]}=“${match[2]!.slice(0, 6)}…”).`);
  return found;
}

/** Script types a browser runs as plain JavaScript (no type at all is one of them). */
const PLAIN_SCRIPT = new Set([
  "",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/x-javascript",
]);

/** Every check, over the planned files. */
export function checkProject({ files, read, given }: CheckInput): Finding[] {
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
      // A tag inside <!-- --> is not on the page.
      const page = withoutHtmlComments(text);
      const lower = page.toLowerCase();
      for (const tag of page.matchAll(/<script\b[^>]*>/gi)) {
        const src = attribute(tag[0], "src");
        const type = (attribute(tag[0], "type") ?? "").trim().toLowerCase();
        if (src === null) {
          // An inline script is checked the same way; JSON, import maps and templates are not scripts.
          if (!PLAIN_SCRIPT.has(type)) continue;
          const start = tag.index + tag[0].length;
          const end = lower.indexOf("</script", start);
          if (usesModuleSyntax(page.slice(start, end === -1 ? undefined : end)))
            found({
              file,
              problem: `${file} has an inline <script> that uses import/export, which only works in a module script. Add type="module" to that <script> tag.`,
            });
          continue;
        }
        const target = localTarget(file, src);
        if (!target) continue;
        const script = read(target);
        if (script === null) {
          found({
            file,
            problem: `${file} loads ${src} with a <script> tag, but there is no such file.`,
            related: planned(target) ? [planned(target)!] : undefined,
          });
        } else if (type !== "module" && usesModuleSyntax(script)) {
          found({
            file,
            problem: `${file} loads ${target} with a plain <script src="${src}"> tag, but ${target} uses import/export, which only works in a module script. Add type="module" to the tag, or take the import/export out of ${target}.`,
            related: [planned(target) ?? target],
          });
        }
      }
      // An id must be unique on its page: a script that looks it up gets only the first.
      for (const id of duplicateIds(text))
        found({
          file,
          problem: `${file} has id="${id}" on more than one element; an id must be unique on its page. Give the repeated elements a class instead (class="${id}"), and look them up with querySelectorAll(".${id}").`,
        });
      // A missing stylesheet or page is a gap; a missing picture, icon, font or video is the user's to add.
      for (const tag of page.matchAll(/<link\b[^>]*>/gi)) {
        if (/(?:^|[\s-])(?:icon|manifest)(?:$|\s)/i.test(attribute(tag[0], "rel") ?? "")) continue;
        const reference = attribute(tag[0], "href");
        const target = localTarget(file, reference);
        if (target && WRITTEN.has(extensionOf(target)) && read(target) === null)
          found({
            file,
            problem: `${file} has a <link> pointing at ${reference}, but there is no such file.`,
            related: planned(target) ? [planned(target)!] : undefined,
          });
      }
    }

    if (isScript(file)) {
      const code = withoutComments(text);
      const check = (specifier: string, names: string[]) => {
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) return;
        if (MEDIA.has(extensionOf(specifier.split(/[?#]/)[0]!))) return;
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
        /^[ \t]*export\s+(type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{([^}]*)\})\s*from\s*["']([^"']+)["']/gm,
      ))
        check(match[3]!, match[1] || !match[2] ? [] : importedNames(`{${match[2]}}`));
    }

    if (extensionOf(file) === "json" || isJsonc(file)) {
      try {
        JSON.parse(isJsonc(file) ? plainJson(text) : text);
      } catch (error) {
        found({ file, problem: `${file} is not valid JSON (${(error as Error).message}).` });
      }
    }

    if (!BINARY.has(extensionOf(file)) && !text.includes("\0"))
      for (const finding of keysIn(file, text, given)) found(finding);
  }

  // Element ids a script looks for must exist in some page of the project: only ids, classes are too noisy.
  const pages = files.filter(isHtml).filter((file) => texts.get(file) !== null);
  if (pages.length > 0) {
    const sources = files.map((file) => texts.get(file) ?? "").join("\n");
    // A script that gives an element an id it builds at run time could make any id: then nothing can be said for
    // sure. Comparing an id (`x.id === "a"`) or setting a written one (`el.id = "a"`) builds nothing.
    const dynamic =
      /\.id\s*=(?!=)(?!\s*["'])|setAttribute\(\s*["']id["']\s*,(?!\s*["'])|\bid\s*=\s*["'][^"']*\$\{|\bid\s*=\s*\{(?!\s*["'])/.test(
        sources,
      );
    if (!dynamic) {
      const declared = new Set<string>();
      for (const pattern of [
        /\bid\s*=\s*["']([\w-]+)["']/g,
        /\.id\s*=\s*["']([\w-]+)["']/g,
        /setAttribute\(\s*["']id["']\s*,\s*["']([\w-]+)["']/g,
        /\bid\s*:\s*["']([\w-]+)["']/g,
        /\bid\s*=\s*\{\s*["']([\w-]+)["']\s*\}/g,
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

  // Plain scripts on one page share their top-level names: the same const, let or class declared in two of them stops
  // the page on load ("has already been declared"); the same function silently replaces the first one.
  for (const page of files.filter(isHtml)) {
    const text = texts.get(page);
    if (!text) continue;
    const seen = new Map<string, string>();
    for (const tag of withoutHtmlComments(text).matchAll(/<script\b[^>]*>/gi)) {
      const type = (attribute(tag[0], "type") ?? "").trim().toLowerCase();
      const target = localTarget(page, attribute(tag[0], "src"));
      const file = target && planned(target);
      const code = file ? texts.get(file) : null;
      if (!file || !code || !PLAIN_SCRIPT.has(type) || usesModuleSyntax(code)) continue;
      for (const name of topLevelNames(code)) {
        const first = seen.get(name);
        if (first && first !== file)
          found({
            file,
            problem: `${file} and ${first} both declare ${name} at the top level, and ${page} loads both as plain scripts, which share their top-level names: the page stops on load ("Identifier '${name}' has already been declared"), or one replaces the other. Rename it in ${file}, or put ${file}'s code inside one name of its own: window.Something = (() => { … return { start }; })();`,
            related: [first],
          });
        else seen.set(name, file);
      }
    }
  }

  return findings;
}

/**
 * The names a plain script declares at its top level (const, let, class or function written at the start of a line):
 * the ones that clash with another script's on the same page. `var` may be declared twice, so it isn't counted.
 */
export function topLevelNames(code: string): string[] {
  const names = new Set<string>();
  for (const match of withoutComments(code).matchAll(
    /^(?:const|let|class|(?:async\s+)?function\s*\*?)\s+([A-Za-z_$][\w$]*)/gm,
  ))
    names.add(match[1]!);
  return [...names];
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
