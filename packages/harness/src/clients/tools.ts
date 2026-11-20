import { z } from "zod";

import { addToOffer, keepOfferSaid, mergeOffer, OFFER_LISTS, type OfferRemovals } from "@mrog/clients";
import { CompanyStage, OfferProfile, PlaybookId, SIGNAL_KINDS, type UpdateOfferInput } from "@mrog/shared";
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
  /**
   * Several companies on one page (a round-up of openings), each with the words about it and its sign. `signQuote`:
   * the sign's own quote, when the Checker gave one apart from the company's.
   */
  companies: { name: string; quote: string; kind: string; date: string; signQuote?: string }[];
}

export interface Capture {
  base?: OfferProfile;
  profile?: OfferProfile;
  /** The Interviewer: what the user said this turn, which every saved list item, size and price must be backed by. */
  said?: string;
  /** The Interviewer: what its saves left out because the user didn't say it. */
  dropped?: string[];
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
  /** Items to take out of a list, by field. */
  remove: z
    .object(Object.fromEntries(OFFER_LISTS.map((field) => [field, z.array(text(200)).max(20)])))
    .partial()
    .optional(),
});

/**
 * The arguments with any written as JSON inside a text field taken out of it: a 9B model sent
 * `{ offer: '{"industries": ["law firms"]}' }`. The fields the JSON names are used as the arguments they meant to
 * be (still checked against what the user said); the text field itself is dropped.
 */
function unwrapJson(args: z.infer<typeof OfferArgs>): z.infer<typeof OfferArgs> {
  const out: Record<string, unknown> = { ...args };
  for (const field of ["offer", "price"] as const) {
    const raw = args[field]?.trim();
    if (!raw?.startsWith("{")) continue;
    delete out[field];
    try {
      const inner = OfferArgs.partial().safeParse(JSON.parse(raw));
      if (inner.success) for (const [key, value] of Object.entries(inner.data)) out[key] ??= value;
    } catch {
      // Not JSON after all: the field is dropped, as text that isn't what you sell.
    }
  }
  return out as z.infer<typeof OfferArgs>;
}

/**
 * save_offer: list items are added to the profile's lists, items named under `remove` are taken out, and only what
 * the user said is kept (4.4). Before, a list was sent whole and replaced the one there.
 */
export const saveOfferTool = (capture: Capture): ToolSpec =>
  defineTool({
    name: "save_offer",
    description:
      "Save what the user told you about what they sell and their ideal client. Send only the fields that changed. For a list (areas, industries, buyers, must-haves, exclusions) send only the new items: they are added to the list. To take items out, name them under remove. Other fields replace what was there.",
    args: OfferArgs,
    risk: () => safe("Save the client profile"),
    run: async (args) => {
      const base = capture.profile ?? capture.base ?? OfferProfile.parse({});
      const { remove, ...fields } = unwrapJson(args);
      // Only what the user said: a small model fills in a size or an industry nobody mentioned.
      const { change, dropped } = keepOfferSaid(fields as UpdateOfferInput, capture.said ?? "");
      try {
        capture.profile = mergeOffer(base, addToOffer(base, change, remove as OfferRemovals | undefined));
      } catch (error) {
        return `Not saved: ${(error as Error).message}. Fix the field and call save_offer again.`;
      }
      if (dropped.length > 0) {
        capture.dropped = [...(capture.dropped ?? []), ...dropped];
        return `Saved, except what the user didn't say: ${dropped.join("; ")}. Don't save those unless the user says them. Now ask the user your next questions in plain words.`;
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

/** Names a 9B model gives finish_page's lists, for the ones it means. */
const REPORT_ALIASES: Record<string, string> = {
  signs: "signals",
  sign: "signals",
  requirements: "verdicts",
};
const REPORT_LISTS = ["facts", "signals", "traits", "verdicts", "links", "companies"];

/**
 * finish_page's arguments as a small model really writes them, made regular before they're checked (found in the
 * benchmark): a list under another name ("signs" for signals), and a list written as JSON text. Every item is still
 * checked against the page afterwards.
 */
function tidyReport(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const [alias, name] of Object.entries(REPORT_ALIASES))
    if (alias in out) {
      if (out[name] === undefined) out[name] = out[alias];
      delete out[alias];
    }
  for (const name of REPORT_LISTS) {
    const value = out[name];
    if (typeof value !== "string" || !value.trim().startsWith("[")) continue;
    try {
      out[name] = JSON.parse(value);
    } catch {
      delete out[name];
    }
  }
  return out;
}

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
            // A small model often nests the sign under the company: read it there too.
            sign: z
              .object({ kind: text(30), date: text(60), quote: text(500) })
              .partial()
              .optional(),
          }),
        )
        .max(10)
        .default([]),
    }),
    prepare: tidyReport,
    risk: () => safe("Report on the page"),
    run: async (args) => {
      capture.result = {
        ...args,
        companies: args.companies.map(({ sign, ...company }) => ({
          ...company,
          // The company's own "kind" is often "company", not a sign: the nested sign's kind is the one meant.
          kind: (SIGNAL_KINDS as readonly string[]).includes(company.kind)
            ? company.kind
            : sign?.kind || company.kind,
          date: company.date || sign?.date || "",
          ...(sign?.quote ? { signQuote: sign.quote } : {}),
        })),
      };
      return "Recorded. Reply with one short sentence and stop.";
    },
  });

export const roleTool: Record<string, (capture: Capture) => ToolSpec> = {
  interviewer: saveOfferTool,
  searcher: planSearchesTool,
  checker: finishPageTool,
};
