import type { Playbook } from "./types";

export const recruitment: Playbook = {
  id: "recruitment",
  label: "Recruitment",
  matches: /recruit|staffing|headhunt|talent acquisition|executive search|temp(orary)? staff/,
  signals: ["asking", "hiring", "growing", "expanding", "funding"],
  traits: ["has_staff", "seasonal", "multi_site"],
  clues: [],
  buyerTitles: ["Head of HR", "HR Manager", "Founder", "Operations Director"],
  hiringTitles: ["Talent Acquisition Manager", "Internal Recruiter", "HR Manager", "People Partner"],
  serviceNames: ["recruitment agency", "recruiter", "staffing agency", "recruitment partner"],
  sells:
    /recruitment (agency|consultancy|specialists|partner)|staffing (agency|solutions)|executive search|we (place|find|recruit) (candidates|talent)/,
  tenderWords: ["recruitment services", "temporary staff", "agency staff"],
  questions: ["Which roles do you recruit for?", "Permanent, temporary, or both?"],
};
