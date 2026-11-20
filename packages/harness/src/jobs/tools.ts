import { z } from "zod";

import { addToProfile, keepWhatWasSaid, mergeProfile, PROFILE_LISTS, type ProfileRemovals } from "@mrog/jobs";
import { JobProfile, Workplace, type UpdateJobProfileInput } from "@mrog/shared";
import { defineTool, safe, type ToolSpec } from "@mrog/tools";

/**
 * The three role tools. Each hands its result back to the service through the turn's capture; none reaches outside
 * the app. The service checks everything it gets (the Checker's facts against the page, links against the page's own).
 */

/** What a Checker said about a page, before the service checks it. */
export interface CheckerResult {
  kind: "job" | "list" | "other";
  facts: { name: string; value: string; quote: string }[];
  verdicts: { id: string; verdict: string; reason: string }[];
  summary: string;
  company: { text: string; quote: string }[];
  links: string[];
}

/** What the current turn of a role handed back. */
export interface Capture {
  /** The Interviewer: the profile it starts from, and the profile after its saves. */
  base?: JobProfile;
  profile?: JobProfile;
  /** The Interviewer: what the user said this turn, which every saved list item and salary must be backed by. */
  said?: string;
  /** The Interviewer: what its saves left out because the user didn't say it. */
  dropped?: string[];
  plan?: { searches: string[]; careerPages: string[] };
  result?: CheckerResult;
}

const text = (max: number) => z.string().trim().max(max);

const ProfileArgs = z.object({
  titles: z.array(text(80)).max(10).optional(),
  relatedTitles: z.array(text(80)).max(15).optional(),
  seniority: text(80).optional(),
  workplace: z.array(Workplace).max(3).optional(),
  places: z.array(text(100)).max(10).optional(),
  travel: text(200).optional(),
  minSalary: z
    .object({ amount: z.number().min(0), currency: text(8), period: z.enum(["year", "month", "hour"]) })
    .nullable()
    .optional(),
  mustHaves: z.array(text(200)).max(20).optional(),
  niceToHaves: z.array(text(200)).max(20).optional(),
  dealBreakers: z.array(text(200)).max(20).optional(),
  rightToWork: text(300).optional(),
  avoidIndustries: z.array(text(100)).max(20).optional(),
  avoidCompanies: z.array(text(100)).max(50).optional(),
  languages: z.array(text(60)).max(10).optional(),
  experience: text(2000).optional(),
  remove: z
    .object(Object.fromEntries(PROFILE_LISTS.map((field) => [field, z.array(text(200)).max(20)])))
    .partial()
    .optional()
    .describe('Items to take out of a list, by field (for example { mustHaves: ["Go"] })'),
});

export const saveProfileTool = (capture: Capture): ToolSpec =>
  defineTool({
    name: "save_profile",
    description:
      "Save what the user told you about the job they want. Send only the fields that changed. For a list (titles, must-haves, deal-breakers…) send only the new items: they are added to the list. To take items out, name them under remove. Other fields replace what was there.",
    args: ProfileArgs,
    risk: () => safe("Save the job profile"),
    run: async (args) => {
      const base = capture.profile ?? capture.base ?? JobProfile.parse({});
      const { remove, ...fields } = args;
      // Only what the user said: a small model fills in a salary or a skill nobody mentioned.
      const { change, dropped } = keepWhatWasSaid(fields as UpdateJobProfileInput, capture.said ?? "");
      try {
        capture.profile = mergeProfile(
          base,
          addToProfile(base, change, remove as ProfileRemovals | undefined),
        );
      } catch (error) {
        return `Not saved: ${(error as Error).message}. Fix the field and call save_profile again.`;
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
    description: "Hand the bot the web searches to run and the career pages to read. Call it once.",
    args: z.object({
      searches: z.array(text(150).min(3)).max(10),
      careerPages: z.array(text(500)).max(10).default([]),
    }),
    risk: () => safe("Plan the searches"),
    run: async (args) => {
      capture.plan = { searches: args.searches, careerPages: args.careerPages };
      return "The bot will run these. Reply with one short sentence and stop.";
    },
  });

export const finishJobTool = (capture: Capture): ToolSpec =>
  defineTool({
    name: "finish_job",
    description:
      'Say what the page is. kind "job": its facts (each with an exact quote), a verdict per requirement, a one-line summary, and what it says about the company (with quotes). kind "list": links to jobs that may fit. kind "other": neither.',
    args: z.object({
      kind: z.enum(["job", "list", "other"]),
      facts: z
        .array(z.object({ name: text(40), value: text(300), quote: text(500) }))
        .max(12)
        .default([]),
      verdicts: z
        .array(z.object({ id: text(10), verdict: text(20), reason: text(400).default("") }))
        .max(40)
        .default([]),
      summary: text(300).default(""),
      company: z
        .array(z.object({ text: text(300), quote: text(500) }))
        .max(8)
        .default([]),
      links: z.array(text(2000)).max(15).default([]),
    }),
    risk: () => safe("Report on the page"),
    run: async (args) => {
      capture.result = args;
      return "Recorded. Reply with one short sentence and stop.";
    },
  });

/** The tool of each role that has one of these (the Visual helper uses only screen tools). */
export const roleTool: Record<string, (capture: Capture) => ToolSpec> = {
  interviewer: saveProfileTool,
  searcher: planSearchesTool,
  checker: finishJobTool,
};
