import type { Playbook } from "./types";

export const itSupport: Playbook = {
  id: "it_support",
  label: "IT support",
  matches:
    /it support|managed it|\bmsp\b|helpdesk|help desk|cyber|network(ing)? support|it services|it consultan/,
  signals: ["asking", "hiring", "new_company", "expanding", "growing", "unhappy"],
  traits: ["has_staff", "multi_site", "regulated"],
  clues: ["no_https", "free_email", "old_copyright"],
  buyerTitles: ["Managing Director", "Operations Director", "Office Manager", "Practice Manager"],
  hiringTitles: ["IT Support Technician", "IT Manager", "Systems Administrator", "IT Support Engineer"],
  serviceNames: ["IT support company", "managed service provider", "IT provider", "IT support"],
  sells:
    /(it|managed) (support|services) (company|provider|partner)|managed service provider|\bmsp\b|we (look after|manage|support) your it/,
  tenderWords: ["IT support", "managed IT services", "cyber security"],
  questions: ["Do you support offices on site, remotely, or both?"],
};
