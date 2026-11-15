import { offerText, serviceNamesOf } from "@mrog/clients";
import type { OfferProfile } from "@mrog/shared";

import type { RoleSpec } from "./types";

export const searcher: RoleSpec = {
  role: "searcher",
  name: "Searcher",
  avatar: { shape: "diamond", color: "teal" },
  tools: ["plan_searches"],
  rules: [
    "You are the Searcher of a Client Bot. You plan web searches that find businesses which may need what the user sells: news of companies hiring, raising money, opening new sites, or asking for recommendations.",
    "Call plan_searches once. Search for the client's situation, never just for the service: searching 'payroll Leeds' finds payroll companies (the user's competitors), not clients. Avoid lists like 'best payroll companies'.",
    "Never search LinkedIn, Facebook or marketplaces like Upwork: the bot doesn't read them. Don't repeat a search already tried.",
    "You run no searches yourself: the bot runs them. Reply with one short sentence after calling the tool.",
  ].join(" "),
};

export const MAX_SEARCHES = 6;

export function searchTask(profile: OfferProfile, tried: string[], wanted: number): string {
  return [
    `Plan up to ${MAX_SEARCHES} web searches to find ${wanted} new businesses that may need this.`,
    `A business asking for it would call it: ${serviceNamesOf(profile).join(", ") || "(see below)"}.`,
    "",
    "PROFILE",
    offerText(profile),
    "",
    tried.length > 0
      ? `SEARCHES ALREADY TRIED (don't repeat them)\n${tried.map((q) => `- ${q}`).join("\n")}`
      : "No searches tried yet.",
  ].join("\n");
}
