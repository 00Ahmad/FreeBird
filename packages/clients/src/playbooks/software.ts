import type { Playbook } from "./types";

export const software: Playbook = {
  id: "software",
  label: "Software development",
  matches:
    /software|app development|\bapps?\b|web development|website|developers?|\bsaas\b|digital product|bespoke system|mobile app/,
  signals: ["asking", "hiring", "funding", "expanding", "growing", "unhappy"],
  traits: ["multi_site", "international"],
  clues: ["old_copyright", "no_https", "orders_by_phone", "no_booking"],
  buyerTitles: ["Founder", "CTO", "Managing Director", "Head of Product", "Operations Director"],
  hiringTitles: [
    "Contract Software Developer",
    "Freelance Developer",
    "Web Developer",
    "Head of Engineering",
  ],
  serviceNames: ["software development company", "development agency", "app developer", "web developer"],
  sells:
    /software (development|house|agency|consultancy|studio)|development agency|we (build|develop|design) (apps|software|websites|web apps)|app developers|web design agency/,
  tenderWords: ["software development", "website development", "digital services", "application development"],
  questions: ["Do you build websites, apps, or bespoke systems?", "What size of project do you take on?"],
};
