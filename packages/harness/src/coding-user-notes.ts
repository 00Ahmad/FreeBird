/**
 * What the user types while the team works, is stopped or waits for them: a message that names a planned file
 * ("movies.js:289 Uncaught TypeError…") is about that file, so it goes to that file's card as the user's comment and
 * the Developer fixes it next. Pure: which files a message names, and whether it reports a fault.
 */

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The planned files a message names, in the order it names them: by full path, or by file name alone when only one
 * planned file has that name. "movies.js:289", "in js/movies.js." and "(movies.js)" all name movies.js; "movies.json"
 * and "oldmovies.js" don't.
 */
export function filesNamed(text: string, paths: string[]): string[] {
  const byName = new Map<string, string[]>();
  for (const path of paths) {
    const name = (path.split("/").at(-1) ?? path).toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }
  const found: { path: string; at: number }[] = [];
  for (const path of paths) {
    const name = (path.split("/").at(-1) ?? path).toLowerCase();
    const forms = byName.get(name)!.length === 1 && name !== path.toLowerCase() ? [path, name] : [path];
    let at = -1;
    for (const form of forms) {
      const match = new RegExp(`(?<![\\w./\\\\-])${escape(form)}(?![\\w-]|\\.\\w)`, "i").exec(
        text.replace(/\\/g, "/"),
      );
      if (match && (at === -1 || match.index < at)) at = match.index;
    }
    if (at !== -1) found.push({ path, at });
  }
  return found.toSorted((a, b) => a.at - b.at).map((entry) => entry.path);
}

/** A file and line ("app.js:12"), or words for something going wrong. */
const FAULT =
  /\.\w+:\d+|\b(?:error|errors|exception|uncaught|crash(?:es|ed|ing)?|traceback|typeerror|referenceerror|syntaxerror|undefined|null|broken|bug|fails?|failing|doesn'?t work|does not work|not working|won'?t|can'?t|cannot|nothing happens|blank)\b/i;

/** Whether a message reports something wrong, rather than asking for a change. */
export const reportsFault = (text: string): boolean => FAULT.test(text);

/** "app.js", "app.js and api.js", "app.js, api.js and main.js". */
export function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The comment a card gets from the user's message. */
export const userNote = (text: string): string => text.trim();

/** What the Coding Bot says when it passed a message on to cards. */
export function passedOnReply(paths: string[], when: "running" | "waiting" | "reopened"): string {
  const cards = `${listOf(paths)}'${paths.length === 1 ? "s card" : " cards"}`;
  if (when === "running")
    return `I passed that on to ${cards}: the Developer fixes it next, and QA checks it again.`;
  if (when === "reopened")
    return `I sent ${listOf(paths)} back to the Developer with your message. It fixes it, QA checks it again, and I'll tell you when it's done.`;
  return `I added that to ${cards}. Press Resume and the Developer fixes it first.`;
}

/**
 * Whether the user's note is the newest word on the card (only the Developer's own notes since), so the Developer and
 * QA are told it comes first.
 */
export const userSpokeLast = (comments: { author: string }[]): boolean =>
  comments.findLast((entry) => entry.author !== "developer")?.author === "user";

/** Said to the Developer and QA when the user's note is the newest word on the card. */
export const USER_NOTE_FIRST =
  "The note from the user above comes first: they saw this themselves. Fix (or, for QA, check) exactly what it says, at the place it names.";

/** Added to the status reply when a message names no planned file. */
export const NAME_A_FILE =
  "To pass something on to the Developer, name the file it's about (like app.js, or app.js:12 with the error).";
