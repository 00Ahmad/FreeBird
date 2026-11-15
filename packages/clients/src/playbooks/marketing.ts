import type { Playbook } from "./types";

export const marketing: Playbook = {
  id: "marketing",
  label: "Marketing",
  matches: /marketing|\bseo\b|social media|advertis|branding|\bbrand\b|\bppc\b|\bpr\b|public relations/,
  signals: ["asking", "hiring", "first_hire", "funding", "expanding", "growing", "unhappy"],
  traits: ["multi_site"],
  clues: ["old_copyright", "no_blog", "no_booking", "free_email", "no_https"],
  buyerTitles: ["Founder", "Managing Director", "Marketing Manager", "Head of Marketing"],
  hiringTitles: ["Marketing Manager", "Marketing Executive", "Head of Marketing", "Social Media Manager"],
  serviceNames: ["marketing agency", "digital marketing agency", "SEO agency", "social media agency"],
  sells:
    /(marketing|seo|digital|creative|branding|social media|pr|advertising) agency|marketing services|we help (brands|businesses) grow|growth agency/,
  tenderWords: ["marketing", "advertising", "communications campaign", "social media"],
  questions: ["Which channels do you work in (for example SEO, social, paid ads, PR)?"],
};
