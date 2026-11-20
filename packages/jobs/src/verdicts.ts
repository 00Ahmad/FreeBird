import type { MatchVerdict, SalaryFloor, Workplace } from "@mrog/shared";

import { amounts, workplaceOf } from "./source-check";
import { fold } from "./text";

/**
 * Verdicts code can give from facts already checked against the page, instead of the Checker's: where the job is
 * done, and whether it pays enough. Null when code can't tell, and then the Checker's verdict stands.
 */

export interface CodeVerdict {
  verdict: MatchVerdict;
  reason: string;
}

/** The workplace verdict from the confirmed workplace fact. */
export function workplaceVerdict(fact: string | null, wanted: readonly Workplace[]): CodeVerdict | null {
  if (!fact || wanted.length === 0) return null;
  const kind = workplaceOf(fact) as Workplace | null;
  if (!kind) return null;
  return wanted.includes(kind)
    ? { verdict: "meets", reason: `${kind[0]!.toUpperCase()}${kind.slice(1)}, as you want.` }
    : {
        verdict: "misses",
        reason: `The job is ${kind === "office" ? "office-based" : kind}; you want ${wanted.join(" or ")}.`,
      };
}

const CURRENCIES: [RegExp, string][] = [
  [/£|\bgbp\b|\bpounds?\b/, "GBP"],
  [/€|\beur\b|\beuros?\b/, "EUR"],
  [/\bus\$|\$|\busd\b|\bdollars?\b/, "USD"],
  [/\bcad\b|\bc\$/, "CAD"],
  [/\baud\b|\ba\$/, "AUD"],
  [/\binr\b|₹|\brupees?\b/, "INR"],
  [/\bpkr\b/, "PKR"],
];

/** The currency a text names, as a code, or null. */
export function currencyOf(text: string): string | null {
  const t = fold(text);
  // C$ and A$ before $: the longer form decides.
  for (const [pattern, code] of [CURRENCIES[3]!, CURRENCIES[4]!, ...CURRENCIES])
    if (pattern.test(t)) return code;
  return null;
}

/** The pay period a text names, or null. */
export function periodOf(text: string): SalaryFloor["period"] | null {
  const t = fold(text);
  if (/\b(per|an|a|\/)\s*(hour|hr)\b|\bhourly\b|\/h\b/.test(t)) return "hour";
  if (/\b(per|a|\/)\s*(month|mo)\b|\bmonthly\b|\bpcm\b/.test(t)) return "month";
  if (/\b(per|a|an|\/)\s*(year|annum|yr)\b|\bannual(ly)?\b|\bp\.?a\.?\b|\bper-year/.test(t)) return "year";
  return null;
}

/**
 * The salary verdict from the confirmed salary fact: the top of its range against your lowest, when it names your
 * currency and period (a currency it doesn't name is taken to be yours only when you gave a symbol-free one and it
 * gives none either). Anything else is left to the Checker.
 */
export function salaryVerdict(fact: string | null, floor: SalaryFloor | null): CodeVerdict | null {
  if (!fact || !floor) return null;
  const numbers = amounts(fact).filter((n) => n > 0);
  if (numbers.length === 0) return null;
  const wantedCurrency = currencyOf(floor.currency) ?? floor.currency.toUpperCase();
  const currency = currencyOf(fact);
  const period = periodOf(fact) ?? (Math.max(...numbers) >= 10_000 ? "year" : null);
  if (!currency || currency !== wantedCurrency || period !== floor.period) return null;
  const top = Math.max(...numbers);
  const shown = (n: number) => n.toLocaleString("en-US");
  return top >= floor.amount
    ? {
        verdict: "meets",
        reason: `Pays up to ${shown(top)} ${currency} a ${period}, at least your ${shown(floor.amount)}.`,
      }
    : {
        verdict: "misses",
        reason: `Pays at most ${shown(top)} ${currency} a ${period}, under your ${shown(floor.amount)}.`,
      };
}
