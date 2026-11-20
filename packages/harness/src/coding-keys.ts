/**
 * Keys in the brief. A small model asked to copy a 200-character token into a file retypes it, and gets it wrong
 * (the movies run: the TMDB key one character short, the token garbled). So the keys the user gives are taken out of
 * the brief when it arrives and kept once; the roles only ever see a name, like {{TMDB_API_KEY}}. Where the code needs
 * the key, the Developer writes that name, and the real key goes into the file as it is written; reading the file back
 * shows the name again. The key is never in what a model reads or writes. Pure: finding, naming, hiding, filling.
 */

export interface BriefKey {
  /** Upper case with underscores, as written between the braces: TMDB_API_KEY. */
  name: string;
  value: string;
}

/** How a key appears to the roles. */
export const placeholder = (name: string) => `{{${name}}}`;

/** Keys whose start says what they are. */
const KNOWN =
  /(?:sk-(?:proj-|ant-)?|sk_(?:live|test)_|pk_(?:live|test)_|rk_(?:live|test)_|gh[pousr]_|github_pat_|xox[abposr]-|AKIA|ASIA|AIza)[A-Za-z0-9_-]{16,}/;
/** A JSON web token (most "access tokens"). */
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
/** A long run of letters and digits, which is a key only when the words before it say so. */
const LONG = /[A-Za-z0-9][A-Za-z0-9_\-.]{18,}[A-Za-z0-9]/;
const CANDIDATE = new RegExp(`${KNOWN.source}|${JWT.source}|${LONG.source}`, "g");
/** Words that say a value is a key. */
const KEY_WORD =
  /\b(?:api[\s_-]?key|key|token|secret|password|passcode|bearer|auth(?:orization)?|credential|client[\s_-]?id)\b/i;

/** Whether a long run looks random enough to be a key (letters and digits mixed), not a word or an address. */
const random = (value: string) =>
  /[0-9]/.test(value) &&
  /[A-Za-z]/.test(value) &&
  !/^\d+$/.test(value) &&
  !/^[a-z]+(?:[-_.][a-z]+)*$/i.test(value);

/**
 * The words that label a value: the start of its own line, or, when the value starts its line, the line before
 * ("TMDB API Key:" on one line and the key on the next).
 */
function labelOf(before: string): string {
  const lines = before.split("\n");
  const own = lines.at(-1) ?? "";
  return own.trim() ? own : (lines.slice(0, -1).findLast((line) => line.trim()) ?? "");
}

/** A key in a web address's query (`?api_key=…`), named after its parameter. */
const IN_ADDRESS = /[?&](api[_-]?key|apikey|key|token|access[_-]?token|appid|auth)=$/i;

/** A name for a key from the words just before it ("TMDB API Key: …" → TMDB_API_KEY). */
function nameFrom(before: string): string {
  const param = IN_ADDRESS.exec(before)?.[1];
  if (param)
    return param
      .replace(/[^A-Za-z0-9]+/g, "_")
      .toUpperCase()
      .replace(/^APIKEY$/, "API_KEY");
  const line = labelOf(before);
  const words = line
    .replace(/[:=\-–—>]+\s*$/, "")
    .replace(/\b(?:is|my|the|use|here'?s|here is|with)\s*$/i, "")
    .match(/[A-Za-z][A-Za-z0-9]*/g);
  const tail = (words ?? []).slice(-4).map((word) => word.toUpperCase());
  // Keep from the last word that names the service or the kind of key, dropping filler.
  const kept = tail.filter(
    (word) => !["IS", "MY", "THE", "A", "AN", "AND", "USE", "HERE", "WITH", "THIS"].includes(word),
  );
  let name = kept.join("_");
  if (!name) name = "API_KEY";
  if (!/(KEY|TOKEN|SECRET|PASSWORD|PASSCODE|ID)$/.test(name)) name = `${name}_KEY`;
  return name.slice(0, 60);
}

/** The keys in a text: known kinds anywhere, and long random runs the words before them call a key. In order. */
export function findKeys(text: string, known: BriefKey[] = []): BriefKey[] {
  const found: BriefKey[] = [];
  const names = new Set(known.map((key) => key.name));
  const values = new Set(known.map((key) => key.value));
  for (const match of text.matchAll(CANDIDATE)) {
    const value = match[0];
    if (values.has(value)) continue;
    const before = text.slice(Math.max(0, match.index - 160), match.index);
    // In an address's query as a key (`?api_key=…`): a key. Otherwise part of an address or a path: not a key unless
    // it is a known kind.
    const queried = IN_ADDRESS.test(before);
    const glued = !queried && /[/@]$|https?:\/\/\S*$/.test(before);
    const sure = KNOWN.test(value) || JWT.test(value) || (queried && random(value));
    if (!sure && (glued || !random(value) || !KEY_WORD.test(labelOf(before)))) continue;
    let name = nameFrom(before);
    for (let n = 2; names.has(name); n++) name = `${nameFrom(before)}_${n}`;
    names.add(name);
    values.add(value);
    found.push({ name, value });
  }
  return found;
}

/** The text with every key replaced by its name in braces. Longer keys first, so one inside another stays whole. */
export function hideKeys(text: string, keys: BriefKey[]): string {
  let out = text;
  for (const key of keys.toSorted((a, b) => b.value.length - a.value.length))
    out = out.split(key.value).join(placeholder(key.name));
  return out;
}

/** The text with every {{NAME}} of a known key replaced by the key itself. */
export function fillKeys(text: string, keys: BriefKey[]): string {
  let out = text;
  for (const key of keys) out = out.split(placeholder(key.name)).join(key.value);
  return out;
}

/** What the Planner is told when the brief had keys. */
export const plannerKeysNote = (keys: BriefKey[]) =>
  `The keys the user gave are shown by name: ${keys.map((key) => placeholder(key.name)).join(", ")}. Plan one settings file that holds them, and say in its purpose which name goes where; the Developer writes the names and FreeBird puts the real keys in.`;

/** What a role is told when the brief had keys. */
export const keysNote = (role: "planner" | "developer" | "qa", keys: BriefKey[]) =>
  role === "planner"
    ? plannerKeysNote(keys)
    : role === "developer"
      ? developerKeysNote(keys)
      : qaKeysNote(keys);

/** What the Developer is told when the brief had keys. */
export const developerKeysNote = (keys: BriefKey[]) =>
  `The keys the user gave are shown by name: ${keys.map((key) => placeholder(key.name)).join(", ")}. Where the code needs one, write its name exactly, braces included, as the value (for example const API_KEY = "${placeholder(keys[0]!.name)}";). FreeBird puts the real key into the file as it is written, and shows the name again when the file is read. Never type a key yourself, and never use a placeholder like YOUR_API_KEY_HERE for these.`;

/** What QA is told when the brief had keys. */
export const qaKeysNote = (keys: BriefKey[]) =>
  `The keys the user gave are shown by name: ${keys.map((key) => placeholder(key.name)).join(", ")}. Where you see one in a file, the file on disk holds the user's real key there: that is correct, not a placeholder, so don't fail it.`;

/** A write's arguments with the keys filled in: the text written, and the text an edit looks for and puts in. */
export function fillArgs<A>(args: A, keys: BriefKey[]): A {
  if (!args || typeof args !== "object") return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const field of ["content", "find", "replace"])
    if (typeof out[field] === "string") out[field] = fillKeys(out[field], keys);
  return out as A;
}

/** The project's own text with every key shown by name: its note, error, activity list and card comments. */
export function hideInProject(
  project: {
    note: string | null;
    error: string | null;
    log?: { text: string }[];
    cards: { comments: { text: string }[] }[];
  },
  keys: BriefKey[],
): void {
  if (project.note) project.note = hideKeys(project.note, keys);
  if (project.error) project.error = hideKeys(project.error, keys);
  for (const line of project.log ?? []) line.text = hideKeys(line.text, keys);
  for (const card of project.cards) for (const said of card.comments) said.text = hideKeys(said.text, keys);
}
