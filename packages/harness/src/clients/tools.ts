import { z } from "zod";

import { mergeOffer } from "@mrog/clients";
import { CompanyStage, OfferProfile, PlaybookId, type UpdateOfferInput } from "@mrog/shared";
import { defineTool, safe, type ToolSpec } from "@mrog/tools";

/**
 * The three role tools. Each hands its result back to the service through the turn's capture; none reaches outside
 * the app. The service checks everything it gets against the page.
 */

export const PAGE_KINDS = ["company", "request", "signal", "list", "competitor", "other"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** What the Checker said about a page, before the service checks it. */
export interface CheckerResult {
  kind: PageKind;
  facts: { name: string; value: string; quote: string }[];
  signals: { kind: string; quote: string; date: string }[];
  traits: { id: string; quote: string }[];
  verdicts: { id: string; verdict: string; reason: string }[];
  /** The company's own web address, when the page shows it. */
  website: string;
  summary: string;
  links: string[];
  /** Several companies on one page (a round-up of openings), each with the words about it and its sign. */
  companies: { name: string; quote: string; kind: string; date: string }[];
}

export interface Capture {
  base?: OfferProfile;
  profile?: OfferProfile;
  plan?: { searches: string[] };
  result?: CheckerResult;
}

const text = (max: number) => z.string().trim().max(max);

const OfferArgs = z.object({
  offer: text(300).optional(),
  playbook: PlaybookId.nullable().optional(),
  price: text(200).optional(),
  areas: z.array(text(100)).max(10).optional(),
  industries: z.array(text(100)).max(15).optional(),
  sizeMin: z.number().int().min(0).nullable().optional(),
  sizeMax: z.number().int().min(0).nullable().optional(),
  stages: z.array(CompanyStage).max(3).optional(),
  buyerTitles: z.array(text(80)).max(10).optional(),
  mustHaves: z.array(text(200)).max(10).optional(),
  excludeIndustries: z.array(text(100)).max(20).optional(),
  excludePlaces: z.array(text(100)).max(20).optional(),
});

export const saveOfferTool = (capture: Capture): ToolSpec =>
  defineTool({
    name: "save_offer",
    description:
      "Save what the user told you about what they sell and their ideal client. Send only the fields that changed; a list field is sent whole (it replaces the list).",
    args: OfferArgs,
    risk: () => safe("Save the client profile"),
    run: async (args) => {
      const base = capture.profile ?? capture.base ?? OfferProfile.parse({});
      try {
        capture.profile = mergeOffer(base, args as UpdateOfferInput);
      } catch (error) {
        return `Not saved: ${(error as Error).message}. Fix the field and call save_offer again.`;
      }
      return "Saved. Now ask the user your next questions in plain words.";
    },
  });

export const planSearchesTool = (capture: Capture): ToolSpec =>
  defineTool({
    name: "plan_searches",
    description: "Hand the bot the web searches to run. Call it once.",
    args: z.object({ searches: z.array(text(150).min(3)).max(10) }),
    risk: () => safe("Plan the searches"),
    run: async (args) => {
      capture.plan = { searches: args.searches };
      return "The bot will run these. Reply with one short sentence and stop.";
    },
  });

export const finishPageTool = (capture: Capture): ToolSpec =>
  defineTool({
    name: "finish_page",
    description:
      "Say what the page is: its kind, the company's facts and signs (each with an exact quote), traits, a verdict per requirement, its own web address, a one-line summary, and for a list the links to companies worth reading.",
    args: z.object({
      kind: z.enum(PAGE_KINDS),
      facts: z
        .array(z.object({ name: text(40), value: text(300).default(""), quote: text(500).default("") }))
        .max(12)
        .default([]),
      signals: z
        .array(z.object({ kind: text(30), quote: text(500), date: text(60).default("") }))
        .max(8)
        .default([]),
      traits: z
        .array(z.object({ id: text(30), quote: text(500) }))
        .max(8)
        .default([]),
      verdicts: z
        .array(z.object({ id: text(10), verdict: text(20), reason: text(400).default("") }))
        .max(30)
        .default([]),
      website: text(300).default(""),
      summary: text(300).default(""),
      links: z.array(text(2000)).max(15).default([]),
      companies: z
        .array(
          z.object({
            name: text(120),
            quote: text(500),
            kind: text(30).default(""),
            date: text(60).default(""),
          }),
        )
        .max(10)
        .default([]),
    }),
    risk: () => safe("Report on the page"),
    run: async (args) => {
      capture.result = args;
      return "Recorded. Reply with one short sentence and stop.";
    },
  });

export const roleTool: Record<string, (capture: Capture) => ToolSpec> = {
  interviewer: saveOfferTool,
  searcher: planSearchesTool,
  checker: finishPageTool,
};
