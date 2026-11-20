import { fold } from "@mrog/jobs";

/** A company's staff numbers as a page states them: a range, either end open. */
export interface StaffRange {
  min: number;
  max: number | null;
}

const NUMBER = "(\\d{1,3}(?:,\\d{3})*|\\d+)";
const PEOPLE = "(employees|staff|people|colleagues|team members|members of staff|workers|strong)";
const num = (raw: string) => Number(raw.replace(/,/g, ""));

/**
 * The staff numbers a piece of text states, or null: "a team of 30", "30 employees", "30+ staff", "50-249 employees",
 * "over 100 people", "fewer than 10 staff". Read by code, so a size is never the model's guess.
 */
export function staffRange(text: string): StaffRange | null {
  const t = fold(text);
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`\\b${NUMBER}\\s*(-|to)\\s*${NUMBER}\\s+${PEOPLE}`).exec(t)))
    return { min: num(m[1]!), max: num(m[3]!) };
  if (
    (m = new RegExp(
      `\\b(over|more than|nearly|almost|around|about|approximately)\\s+${NUMBER}\\s+${PEOPLE}`,
    ).exec(t))
  ) {
    const n = num(m[2]!);
    return m[1] === "over" || m[1] === "more than" ? { min: n + 1, max: null } : { min: n, max: n };
  }
  if ((m = new RegExp(`\\b(fewer than|less than|under)\\s+${NUMBER}\\s+${PEOPLE}`).exec(t)))
    return { min: 0, max: Math.max(0, num(m[2]!) - 1) };
  if ((m = new RegExp(`\\b(up to|at most|max(?:imum)?(?: of)?)\\s+${NUMBER}\\s+${PEOPLE}`).exec(t)))
    return { min: 0, max: num(m[2]!) };
  if ((m = new RegExp(`\\b(at least|from|min(?:imum)?(?: of)?)\\s+${NUMBER}\\s+${PEOPLE}`).exec(t)))
    return { min: num(m[2]!), max: null };
  if ((m = new RegExp(`\\b${NUMBER}\\+\\s*${PEOPLE}`).exec(t))) return { min: num(m[1]!), max: null };
  if ((m = new RegExp(`\\bteam of\\s+${NUMBER}\\b`).exec(t))) return { min: num(m[1]!), max: num(m[1]!) };
  if ((m = new RegExp(`\\b${NUMBER}\\s+${PEOPLE}`).exec(t))) return { min: num(m[1]!), max: num(m[1]!) };
  if (/\b(sole trader|self[- ]employed|one[- ]person business|just me)\b/.test(t)) return { min: 1, max: 1 };
  return null;
}

/** A size as a fact states it: a sentence ("a team of 30"), or a bare number or range ("30", "50-249", "100+"). */
export function staffOf(value: string): StaffRange | null {
  const found = staffRange(value);
  if (found) return found;
  const m = /^\s*(\d[\d,]*)\s*(\+|(?:-|–|to)\s*(\d[\d,]*))?\s*$/.exec(value);
  if (!m) return null;
  if (m[2] === "+") return { min: num(m[1]!), max: null };
  return { min: num(m[1]!), max: m[3] ? num(m[3]) : num(m[1]!) };
}

/** "30", "50–249", "100+": a range for the card. */
export const staffText = (range: StaffRange) =>
  range.max === null
    ? `${range.min}+`
    : range.min === range.max
      ? `${range.min}`
      : `${range.min}–${range.max}`;
