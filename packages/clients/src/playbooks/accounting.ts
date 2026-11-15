import type { Playbook } from "./types";

export const accounting: Playbook = {
  id: "accounting",
  label: "Accounting and bookkeeping",
  matches: /accountan|accounting|bookkeep|\btax\b|\bvat\b|\baudit|year[- ]end accounts|\bcfo\b/,
  signals: ["asking", "hiring", "first_hire", "new_company", "funding", "expanding", "unhappy"],
  traits: ["has_staff", "multi_site", "international"],
  clues: ["free_email"],
  buyerTitles: ["Founder", "Managing Director", "Finance Director", "Owner"],
  hiringTitles: ["Bookkeeper", "Accounts Assistant", "Finance Manager", "Management Accountant"],
  serviceNames: ["accountant", "accounting firm", "bookkeeper", "bookkeeping service"],
  sells:
    /chartered accountants|accountancy (firm|practice|services)|accounting (firm|practice|services)|bookkeeping services|tax (advisers?|advisors?)|we (do|prepare) (your )?(accounts|tax returns)/,
  tenderWords: ["accountancy", "bookkeeping", "audit services"],
  questions: [
    "Which kinds of business do you know best (for example limited companies, sole traders, charities)?",
  ],
};
