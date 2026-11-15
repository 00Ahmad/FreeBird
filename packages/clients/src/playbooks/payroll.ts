import type { Playbook } from "./types";

export const payroll: Playbook = {
  id: "payroll",
  label: "Payroll",
  matches: /payroll|pay ?roll|\bpaye\b|wages|pay slips?|payslips?/,
  signals: ["asking", "hiring", "first_hire", "new_company", "expanding", "growing", "unhappy"],
  traits: ["has_staff", "multi_site", "seasonal", "international"],
  clues: ["free_email"],
  buyerTitles: ["Founder", "Managing Director", "Finance Director", "Head of HR", "Office Manager"],
  hiringTitles: ["Payroll Administrator", "Payroll Officer", "Payroll Specialist", "HR Administrator"],
  serviceNames: ["payroll provider", "payroll bureau", "payroll company", "payroll service"],
  sells:
    /payroll (services|bureau|provider|solutions|outsourcing|software|company)|outsourced payroll|we (run|process|manage|handle) (your )?payroll/,
  tenderWords: ["payroll"],
  questions: ["Do you also handle pensions or HR?", "How many staff should a client have, at least?"],
};
