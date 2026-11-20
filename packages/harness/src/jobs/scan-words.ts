import { MAX_JOB_TARGET } from "@mrog/shared";

/**
 * Reading a Job Bot's or Client Bot's chat message for a scan: whether it asks for one, and how many new jobs or leads.
 * Plain rules: "find jobs paying 40,000" must not start a 40-job scan, and "find clients with 50 staff" must not start
 * a 50-lead one.
 */

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};
const NUMBER =
  "(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty)";
/** What a scan finds, after its number: "10 jobs", "5 new leads", "twenty more roles". */
const UNIT =
  "(?:new\\s+|more\\s+|fresh\\s+)*(?:jobs?|roles?|positions?|openings?|postings?|vacancies|leads?|clients?|companies|businesses|results?)\\b";

const valueOf = (raw: string) => (/^\d/.test(raw) ? Number(raw) : (NUMBER_WORDS[raw.toLowerCase()] ?? NaN));
const inRange = (n: number, max: number) => (n >= 1 && n <= max ? n : null);

/**
 * How many jobs or leads a message asks for, or null. A number counts when a word for what is found follows it
 * ("find 12 jobs"), or, when the bot has just asked how many (`asked`), when the message is little more than the
 * number ("ten please", "let's do 15"). Never a number that is part of an amount ("40,000", "£40", "40k"), a range or
 * a size ("50 staff").
 */
export function countIn(text: string, options: { asked?: boolean; max?: number } = {}): number | null {
  const max = options.max ?? MAX_JOB_TARGET;
  const plain = text.trim();
  const withUnit = new RegExp(`(?<![\\d.,£$€])\\b${NUMBER}\\s+${UNIT}`, "i").exec(plain);
  if (withUnit) return inRange(valueOf(withUnit[1]!), max);
  if (!options.asked && !/^\s*\S+\s*[.!]?\s*$/.test(plain)) return null;
  // An answer to "how many?": short, with one number that isn't part of an amount, a range or a size.
  if (plain.split(/\s+/).length > 5) return null;
  // "10, only tenders" is ten; "40,000" and "4.5" are amounts (a comma or point before a digit).
  const bare = new RegExp(
    `(?<![\\d.,£$€\\w])${NUMBER}(?![\\d%\\w]|[.,]\\d|\\s*(?:k|to|-|–|staff|people|employees)\\b)`,
    "gi",
  );
  const found = [...plain.matchAll(bare)];
  return found.length === 1 ? inRange(valueOf(found[0]![1]!), max) : null;
}

const SCAN_VERB = /\b(scan|search|find|look for|hunt)\b/i;
/** Words about the profile: a message with them may be a change to it, not a request to scan now. */
const PROFILE_WORDS =
  /\b(salary|pay|paying|pays|title|titles|remote|hybrid|office|change|add|remove|update|include|exclude|instead|profile|location|deal-?breakers?|must|industry|industries|staff|employees|price|sell|area|areas|seniority|skills?)\b/i;

/**
 * What a message asks for: a scan; maybe a scan, maybe a change to the profile ("unsure": ask which); or neither.
 * "Can you search for jobs?" is a scan; "Change my search to include Canada" and "find jobs paying 40,000" are unsure.
 */
export function scanIntent(text: string): "scan" | "unsure" | "none" {
  if (!SCAN_VERB.test(text)) return "none";
  return PROFILE_WORDS.test(text) ? "unsure" : "scan";
}

/** Whether a message plainly asks for a scan. */
export const asksForScan = (text: string) => scanIntent(text) === "scan";

/** Said when a message may be a scan request or a change to the profile. */
export const SCAN_OR_PROFILE =
  'Do you want me to start a scan now, or to change your profile? Say "scan" to start one, or tell me the change.';
