import { fold, words } from "@mrog/jobs";

import type { SignalKind } from "./types";

const HIRING =
  /hiring|vacanc|we're recruiting|we are recruiting|job (opening|advert)|join (our|the) team|apply (now|today)|role|position/;

/** Whether the text names one of the playbook's job titles (every word of it). */
export function namesTitle(text: string, titles: string[]): boolean {
  const have = new Set(words(text).map((w) => w.replace(/s$/, "")));
  return titles.some((title) => {
    const want = words(title).map((w) => w.replace(/s$/, ""));
    return want.length > 0 && want.every((w) => have.has(w));
  });
}

/** Hiring for your work: a company advertising a payroll clerk may want to hand payroll to you instead. */
export const hiring: SignalKind = {
  id: "hiring",
  label: "Hiring for your work",
  strength: 0.8,
  freshForDays: 60,
  indicates: (quote, playbook) =>
    namesTitle(quote, playbook.hiringTitles) ||
    (playbook.hiringTitles.length === 0 && HIRING.test(fold(quote))),
  searches: ({ playbook, place }) =>
    playbook.hiringTitles
      .slice(0, 2)
      .flatMap((title) => [
        `"${title}" ${place} site:boards.greenhouse.io`,
        `"${title}" ${place} site:jobs.lever.co`,
      ])
      .map((q) => q.replace(/\s+/g, " ").trim()),
};
