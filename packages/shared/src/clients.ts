import { z } from "zod";

import { BotName } from "./bots";
import { BotId } from "./ids";
import {
  DeadPage,
  JobReader,
  JobRoleSeat,
  JobStatus,
  JobWarning,
  MatchVerdict,
  MAX_DEAD_PAGES,
  MAX_SEARCHES_RUN,
  SearchRun,
  SiteNote,
} from "./jobs";
import { ModelRef } from "./models";

/**
 * A Client Bot interviews you about what you sell and who you sell it to, then, when you start a scan, finds
 * businesses that show signs they may need it (or fit your ideal client and have never posted anything), checks each
 * one against the pages and records it came from, and keeps them on a board. Types and limits only: the logic is in
 * @mrog/clients, the wiring in the harness.
 */
export const CLIENT_ROLES = ["interviewer", "searcher", "checker", "visual"] as const;
export const ClientRole = z.enum(CLIENT_ROLES);
export type ClientRole = z.infer<typeof ClientRole>;

/** Each scan finds at most this many new leads; you choose how many each time. */
export const MAX_CLIENT_TARGET = 50;
export const DEFAULT_CLIENT_TARGET = 10;
export const MAX_LEADS = 500;
/** Fingerprints of companies already shown, so a later scan counts only new ones. */
export const MAX_SEEN_COMPANIES = 3000;
export const MAX_CLIENT_LOG = 50;
/** Watched quiet fits re-checked at the start of one scan. */
export const MAX_WATCH_PER_SCAN = 20;
/** Entries on each of your lists (clients, competitors, do-not-contact). */
export const MAX_LIST_ENTRIES = 2000;
export const MAX_LOOKALIKE_CLIENTS = 10;
export const MAX_CLIENT_SUGGESTIONS = 10;
/** Companies looked at and not shown (a quiet fit below the bar), remembered with why and when. */
export const MAX_NOT_SHOWN = 2000;

/** How far one register query has been read across scans (see @mrog/clients register-pages). */
export const RegisterPage = z.object({
  /** The page to read next (from 1), or the last one read when used up. */
  page: z.number().int().min(1),
  /** Its last page was read: nothing new until it starts again. */
  usedUp: z.boolean(),
  at: z.iso.datetime(),
});
export type RegisterPage = z.infer<typeof RegisterPage>;

/** A company looked at and not shown, with why and when: judged again later (see @mrog/clients not-shown). */
export const NotShown = z.object({
  /** Its fingerprints, by domain and by name. */
  prints: z.array(z.string()).max(2),
  name: z.string().max(200),
  reason: z.string().max(200),
  at: z.iso.datetime(),
});
export type NotShown = z.infer<typeof NotShown>;

const Short = (max: number) => z.string().trim().max(max);
const List = (item: number, count: number) => z.array(Short(item).min(1)).max(count);

/** The ready-made playbooks: default signals, traits, clues and searches for a kind of service. */
export const PLAYBOOK_IDS = [
  "payroll",
  "accounting",
  "marketing",
  "software",
  "it_support",
  "recruitment",
  "generic",
] as const;
export const PlaybookId = z.enum(PLAYBOOK_IDS);
export type PlaybookId = z.infer<typeof PlaybookId>;

/** Signs that a company may need what you sell, now. */
export const SIGNAL_KINDS = [
  "asking",
  "hiring",
  "first_hire",
  "funding",
  "new_company",
  "expanding",
  "growing",
  "unhappy",
] as const;
export const SignalKindId = z.enum(SIGNAL_KINDS);
export type SignalKindId = z.infer<typeof SignalKindId>;

/** Facts about a business that imply a need, with no event. */
export const TRAIT_IDS = ["has_staff", "multi_site", "regulated", "seasonal", "international"] as const;
export const TraitId = z.enum(TRAIT_IDS);
export type TraitId = z.infer<typeof TraitId>;

/** Things the bot sees on a company's own site, checked by code. */
export const CLUE_IDS = [
  "old_copyright",
  "no_https",
  "free_email",
  "no_blog",
  "no_booking",
  "orders_by_phone",
] as const;
export const ClueId = z.enum(CLUE_IDS);
export type ClueId = z.infer<typeof ClueId>;

export const CompanyStage = z.enum(["new", "growing", "established"]);
export type CompanyStage = z.infer<typeof CompanyStage>;

/** What you sell and to whom, from the interview. Every field can be edited on the profile card. */
export const OfferProfile = z.object({
  /** What you sell, in your words ("Outsourced payroll for small businesses"). */
  offer: Short(300).default(""),
  /** Picked by code from `offer`; you can change it. */
  playbook: PlaybookId.nullable().default(null),
  /** Your price, in your words: used to judge the size of client that fits. */
  price: Short(200).default(""),
  /** Where you can serve: towns, regions, countries, or "remote". */
  areas: List(100, 10).default([]),
  /** The industries of your ideal client; "any" for any. */
  industries: List(100, 15).default([]),
  /** Staff numbers of your ideal client; null: no limit. */
  sizeMin: z.number().int().min(0).max(1_000_000).nullable().default(null),
  sizeMax: z.number().int().min(0).max(1_000_000).nullable().default(null),
  stages: z.array(CompanyStage).max(3).default([]),
  /** The signals, traits and clues that matter; the playbook's defaults until you change them. */
  signals: z.array(SignalKindId).max(SIGNAL_KINDS.length).default([]),
  traits: z.array(TraitId).max(TRAIT_IDS.length).default([]),
  clues: z.array(ClueId).max(CLUE_IDS.length).default([]),
  /** Job titles of the people who buy what you sell ("Finance Director"). */
  buyerTitles: List(80, 10).default([]),
  mustHaves: List(200, 10).default([]),
  excludeIndustries: List(100, 20).default([]),
  excludePlaces: List(100, 20).default([]),
});
export type OfferProfile = z.infer<typeof OfferProfile>;

export const CLIENT_FACTS = ["company", "website", "place", "size", "industry", "what"] as const;
export const ClientFactName = z.enum(CLIENT_FACTS);
export type ClientFactName = z.infer<typeof ClientFactName>;

/** One fact about a company, with the words on the page it came from. No quote that checks out: "not stated". */
export const ClientFact = z.object({
  name: ClientFactName,
  value: z.string().nullable(),
  quote: z.string().nullable(),
});
export type ClientFact = z.infer<typeof ClientFact>;

/** A sign the company may need you, with its quote, where it was read and when it happened (when the page says). */
export const LeadSignal = z.object({
  kind: SignalKindId,
  quote: z.string(),
  url: z.string(),
  /** The date of the event (yyyy-mm-dd) when the page states one; null: undated, which counts as weak. */
  date: z.string().nullable(),
  foundAt: z.iso.datetime(),
});
export type LeadSignal = z.infer<typeof LeadSignal>;

/** A trait or a clue, with its evidence. */
export const LeadEvidence = z.object({
  kind: z.enum(["trait", "clue"]),
  id: z.string(),
  quote: z.string(),
  url: z.string(),
});
export type LeadEvidence = z.infer<typeof LeadEvidence>;

/** A way to reach the company. Found by code on the pages read; never guessed. */
export const ContactRoute = z.object({
  kind: z.enum(["contact_page", "email", "phone", "respond"]),
  value: z.string(),
  url: z.string(),
});
export type ContactRoute = z.infer<typeof ContactRoute>;

export const FitKind = z.enum(["industry", "place", "size", "stage", "must"]);
export type FitKind = z.infer<typeof FitKind>;

/** How the company does on one part of your ideal client, and why. */
export const FitLine = z.object({
  kind: FitKind,
  requirement: z.string(),
  verdict: MatchVerdict,
  reason: z.string(),
  /** Decided by the app from facts and records; otherwise the reason is the Checker's own words. */
  byCode: z.boolean().optional(),
});
export type FitLine = z.infer<typeof FitLine>;

/** An official record (a register entry or a tender notice) the lead was confirmed from. */
export const LeadRecord = z.object({
  register: z.string(),
  id: z.string(),
  url: z.string(),
  label: z.string(),
  /** A tender's closing date (yyyy-mm-dd). */
  deadline: z.string().nullable().default(null),
  /** A register's status for the company ("active", "dissolved"). */
  status: z.string().nullable().default(null),
  /** When the register says the company was incorporated (yyyy-mm-dd): its stage is worked out from it. */
  incorporated: z.string().nullable().default(null),
});
export type LeadRecord = z.infer<typeof LeadRecord>;

/** Asking now (a tender, a "seeking a provider" post), a good fit with signs, or a quiet fit with no signs yet. */
export const LeadKind = z.enum(["asking", "signs", "quiet"]);
export type LeadKind = z.infer<typeof LeadKind>;

export const LeadColumn = z.enum(["new", "shortlisted", "contacted", "replied", "won", "not_a_fit"]);
export type LeadColumn = z.infer<typeof LeadColumn>;
export const LEAD_COLUMNS = LeadColumn.options;

export const Lead = z.object({
  id: z.string(),
  kind: LeadKind,
  /** The company's name as confirmed from a page or record. */
  company: z.string(),
  /** The company's own web address (host), when known: one company is one lead. */
  domain: z.string().nullable(),
  /** The page the lead was first read from: always one this bot actually read. */
  url: z.string(),
  site: z.string(),
  readBy: JobReader,
  foundAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  scan: z.number().int().min(1),
  column: LeadColumn,
  facts: z.array(ClientFact),
  signals: z.array(LeadSignal),
  evidence: z.array(LeadEvidence),
  records: z.array(LeadRecord),
  contacts: z.array(ContactRoute),
  fit: z.array(FitLine),
  /** 0 to 100, worked out by code. */
  score: z.number().min(0).max(100),
  /** The company's own site was read and confirmed it. */
  ownSite: z.boolean(),
  summary: z.string(),
  warnings: z.array(JobWarning),
  /** Kept on the watch list: re-checked for new signals when you run a scan. */
  watch: z.boolean(),
  checkedAt: z.iso.datetime(),
  /** What changed when a watched quiet fit showed a new sign ("Started hiring"). */
  movedUp: z.string().nullable(),
  reaction: z.enum(["up", "down"]).nullable(),
  reason: z.string().nullable(),
  note: Short(2000),
});
export type Lead = z.infer<typeof Lead>;

/** One company on one of your lists: by its web address, its name, or both. */
export const ListEntry = z.object({ name: Short(200), domain: Short(200).nullable() });
export type ListEntry = z.infer<typeof ListEntry>;

export const LIST_NAMES = ["clients", "competitors", "doNotContact"] as const;
export const ListName = z.enum(LIST_NAMES);
export type ListName = z.infer<typeof ListName>;

/** Your existing clients, competitors and companies never to contact: never shown as leads. */
export const ClientLists = z.object({
  clients: z.array(ListEntry).max(MAX_LIST_ENTRIES),
  competitors: z.array(ListEntry).max(MAX_LIST_ENTRIES),
  doNotContact: z.array(ListEntry).max(MAX_LIST_ENTRIES),
});
export type ClientLists = z.infer<typeof ClientLists>;

/** What your favourite clients have in common, worked out by code; you see it and can edit it before it is used. */
export const LookalikeProfile = z.object({
  /** Industry codes (UK SIC) most of them share. */
  sicCodes: z.array(Short(10)).max(10),
  sizeMin: z.number().int().min(0).nullable(),
  sizeMax: z.number().int().min(0).nullable(),
  area: Short(100).nullable(),
  /** Company age in years. */
  ageMin: z.number().int().min(0).nullable(),
  ageMax: z.number().int().min(0).nullable(),
  /** How many of your clients it was worked out from. */
  from: z.number().int().min(0),
});
export type LookalikeProfile = z.infer<typeof LookalikeProfile>;

export const LookalikeMatch = z.object({
  /** The client as you wrote it. */
  client: Short(200),
  /** The register entry it was matched to, by name (and place) checked by code. */
  record: Short(200),
  id: Short(20),
});
export type LookalikeMatch = z.infer<typeof LookalikeMatch>;

export const Lookalikes = z.object({
  clients: z.array(ListEntry).max(MAX_LOOKALIKE_CLIENTS),
  /** Which register entry each client was matched to, so a wrong one can be seen and removed. */
  matched: z.array(LookalikeMatch).max(MAX_LOOKALIKE_CLIENTS).default([]),
  profile: LookalikeProfile.nullable(),
  /** You approved the profile: scans use it. */
  approved: z.boolean(),
});
export type Lookalikes = z.infer<typeof Lookalikes>;

export const SUGGESTIBLE_OFFER_FIELDS = ["excludeIndustries", "excludePlaces", "sizeMax", "sizeMin"] as const;

/** A change to your profile suggested by your reactions. Never applied without you. */
export const OfferSuggestion = z.object({
  id: z.string(),
  field: z.enum(SUGGESTIBLE_OFFER_FIELDS),
  value: z.string(),
  because: z.string(),
});
export type OfferSuggestion = z.infer<typeof OfferSuggestion>;

export const ClientScan = z.object({
  number: z.number().int().min(1),
  target: z.number().int().min(1).max(MAX_CLIENT_TARGET),
  kinds: z.array(LeadKind).min(1),
  /** New good leads: what counts toward the target. */
  found: z.number().int().min(0),
  /** New leads that were checked but scored low: on the board, not counted. */
  weaker: z.number().int().min(0),
  /** Watched quiet fits that showed a new sign this scan. */
  movedUp: z.number().int().min(0),
  /** Watched quiet fits re-checked this scan. */
  watched: z.number().int().min(0).default(0),
  pagesRead: z.number().int().min(0),
  visualPages: z.number().int().min(0),
  searchRounds: z.number().int().min(0),
  /** Sources skipped this scan (a register with no key), in plain words. */
  skipped: z.array(z.string()).max(20),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  stopReason: z.string().nullable(),
});
export type ClientScan = z.infer<typeof ClientScan>;

/** The same steps as a Job Bot's: interview, approve, ready, scanning, waiting for you, error. */
export const ClientStatus = JobStatus;
export type ClientStatus = JobStatus;

export const ClientProject = z.object({
  botId: BotId,
  status: ClientStatus,
  roles: z.object({
    interviewer: JobRoleSeat,
    searcher: JobRoleSeat,
    checker: JobRoleSeat,
    visual: JobRoleSeat,
  }),
  profile: OfferProfile,
  leads: z.array(Lead),
  seen: z.array(z.string()).max(MAX_SEEN_COMPANIES),
  /** Companies looked at and not shown, kept apart from `seen` so a later scan can judge them again. */
  notShown: z.array(NotShown).max(MAX_NOT_SHOWN).default([]),
  /** How far each register query has been read, so the next scan asks for the next page. */
  registerPages: z.record(z.string(), RegisterPage).default({}),
  /** Pages that led nowhere (a competitor, a list of providers, nothing about a client, gone), skipped for a while. */
  deadPages: z.array(DeadPage).max(MAX_DEAD_PAGES).default([]),
  /** Web searches run and when, so a later scan doesn't run them again soon. */
  searchesRun: z.array(SearchRun).max(MAX_SEARCHES_RUN).default([]),
  siteNotes: z.array(SiteNote),
  suggestions: z.array(OfferSuggestion).max(MAX_CLIENT_SUGGESTIONS),
  lists: ClientLists,
  lookalikes: Lookalikes,
  /** The watch list is switched off: no re-checks. */
  watchOff: z.boolean(),
  scan: ClientScan.nullable(),
  lastTarget: z.number().int().min(1).max(MAX_CLIENT_TARGET),
  lastKinds: z.array(LeadKind).min(1),
  askingCount: z.boolean(),
  /** The interview's topics asked about so far, and those you skipped, so neither is asked again. */
  interview: z
    .object({ asked: z.array(z.string()).max(20), skipped: z.array(z.string()).max(20) })
    .default({ asked: [], skipped: [] }),
  active: z.object({ role: ClientRole, url: z.string().nullable(), since: z.iso.datetime() }).nullable(),
  handoff: z.object({ url: z.string(), reason: z.string(), since: z.iso.datetime() }).nullable(),
  log: z.array(z.object({ at: z.iso.datetime(), text: z.string() })).max(MAX_CLIENT_LOG),
  note: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.iso.datetime(),
});
export type ClientProject = z.infer<typeof ClientProject>;

const RoleModel = z.object({ model: ModelRef.nullable().optional() });

export const CreateClientBotInput = z.object({
  name: BotName,
  model: ModelRef.nullable().optional(),
  roles: z
    .object({ interviewer: RoleModel, searcher: RoleModel, checker: RoleModel, visual: RoleModel })
    .partial()
    .optional(),
});
export type CreateClientBotInput = z.infer<typeof CreateClientBotInput>;

/**
 * A change to the profile: only the fields sent. Written out without defaults on purpose: `OfferProfile.partial()`
 * would still fill every missing field with its default, so one edit would empty all the others.
 */
export const UpdateOfferInput = z
  .object({
    offer: Short(300),
    playbook: PlaybookId.nullable(),
    price: Short(200),
    areas: List(100, 10),
    industries: List(100, 15),
    sizeMin: z.number().int().min(0).max(1_000_000).nullable(),
    sizeMax: z.number().int().min(0).max(1_000_000).nullable(),
    stages: z.array(CompanyStage).max(3),
    signals: z.array(SignalKindId).max(SIGNAL_KINDS.length),
    traits: z.array(TraitId).max(TRAIT_IDS.length),
    clues: z.array(ClueId).max(CLUE_IDS.length),
    buyerTitles: List(80, 10),
    mustHaves: List(200, 10),
    excludeIndustries: List(100, 20),
    excludePlaces: List(100, 20),
  })
  .partial();
export type UpdateOfferInput = z.infer<typeof UpdateOfferInput>;

export const StartClientScanInput = z.object({
  target: z.number().int().min(1).max(MAX_CLIENT_TARGET),
  kinds: z.array(LeadKind).min(1).max(3).optional(),
});
export type StartClientScanInput = z.infer<typeof StartClientScanInput>;

export const ReactToLeadInput = z.object({
  reaction: z.enum(["up", "down"]).nullable(),
  reason: z.string().trim().max(200).optional(),
});
export type ReactToLeadInput = z.infer<typeof ReactToLeadInput>;

export const MoveLeadInput = z.object({ column: LeadColumn });
export type MoveLeadInput = z.infer<typeof MoveLeadInput>;

export const LeadNoteInput = z.object({ note: Short(2000) });
export type LeadNoteInput = z.infer<typeof LeadNoteInput>;

/** Forgets a lead (its card and quotes); `block` keeps it on do-not-contact so it never comes back. */
export const ForgetLeadInput = z.object({ block: z.boolean() });
export type ForgetLeadInput = z.infer<typeof ForgetLeadInput>;

/** Adds companies to a list: one per line, a name, a web address, or "name, address" (pasted or from a CSV). */
export const AddToListInput = z.object({ list: ListName, text: z.string().max(200_000) });
export type AddToListInput = z.infer<typeof AddToListInput>;

export const RemoveFromListInput = z.object({ list: ListName, entry: ListEntry });
export type RemoveFromListInput = z.infer<typeof RemoveFromListInput>;

/** Your favourite clients for lookalikes: one per line, like a list. */
export const SetLookalikesInput = z.object({ text: z.string().max(20_000) });
export type SetLookalikesInput = z.infer<typeof SetLookalikesInput>;

export const UpdateLookalikeInput = z.object({ profile: LookalikeProfile.partial(), approved: z.boolean() });
export type UpdateLookalikeInput = z.infer<typeof UpdateLookalikeInput>;

export const WatchInput = z.object({ watch: z.boolean() });
export type WatchInput = z.infer<typeof WatchInput>;

export const WatchListInput = z.object({ off: z.boolean() });
export type WatchListInput = z.infer<typeof WatchListInput>;

/** API keys for registers that need one, kept on this computer (UK Companies House). */
export const CLIENT_KEY_NAMES = ["companiesHouse"] as const;
export const ClientKeyName = z.enum(CLIENT_KEY_NAMES);
export type ClientKeyName = z.infer<typeof ClientKeyName>;
export const SetClientKeyInput = z.object({ name: ClientKeyName, key: z.string().trim().max(200) });
export type SetClientKeyInput = z.infer<typeof SetClientKeyInput>;

export const isClientBusy = (status: ClientStatus) => status === "scanning" || status === "waiting_for_you";
