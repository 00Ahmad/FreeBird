import { fold, onPage, siteOf, type PageRead } from "@mrog/jobs";
import {
  SignalKindId,
  type ClientFact,
  type ContactRoute,
  type FitLine,
  type JobReader,
  type Lead,
  type LeadEvidence,
  type LeadKind,
  type LeadRecord,
  type LeadSignal,
  type OfferProfile,
} from "@mrog/shared";

import { parseDate } from "./dates";
import { clientFact } from "./facts";
import { buildFit, excludedBy, type ClaimedVerdict } from "./fit";
import { serviceNamesOf, type Playbook } from "./playbooks";
import type { FitRequirement } from "./profile";
import { scoreLead } from "./score";
import { signalKind } from "./signals";
import { signalStrength } from "./signals/strength";
import { traitById } from "./traits";
import { leadWarnings } from "./warnings";
import { movedUpText, newSignals } from "./watch";

/** Building a lead from the pages and records read for it: every part checked by code, then scored by code. */

/** What the Checker said a page shows, before code checks it. */
export interface SaidSigns {
  signals: { kind: string; quote: string; date?: string }[];
  traits: { id: string; quote: string }[];
}

/**
 * The signs a page really shows: a kind you look for, a quote on the page that says that sign (code checks the words),
 * and its date when the page states one (the Checker's date must be on the page, else the quote's own date is used).
 */
export function checkSigns(
  page: PageRead,
  said: SaidSigns["signals"],
  profile: OfferProfile,
  playbook: Playbook,
  now: Date,
): LeadSignal[] {
  const kept: LeadSignal[] = [];
  const context = { serviceNames: serviceNamesOf(profile), now };
  for (const sign of said) {
    const kind = SignalKindId.safeParse(sign.kind.trim().toLowerCase());
    if (!kind.success || !profile.signals.includes(kind.data)) continue;
    const says = (text: string) => signalKind(kind.data).indicates(text, playbook, context);
    const claimed = sign.quote.trim();
    if (!onPage(page.text, claimed)) continue;
    // The quote is on the page but too thin to say the sign (a headline, "X is hiring"): the page's own sentence that
    // says it is taken instead, found by code. Found in the benchmark: the next sentence named the job.
    const quote = says(claimed) ? claimed : sentenceSaying(page.text, claimed, says);
    if (!quote) continue;
    const dateText = sign.date?.trim() ?? "";
    const date =
      (dateText && onPage(page.text, dateText) ? parseDate(dateText, now) : null) ?? parseDate(quote, now);
    if (kept.some((s) => s.kind === kind.data && s.quote === quote)) continue;
    kept.push({ kind: kind.data, quote, url: page.url, date, foundAt: now.toISOString() });
  }
  return kept;
}

/**
 * The signs you look for that a quote says, by code, strongest first: for a company on a round-up whose sign kind
 * the Checker gave as something else ("competitor", "company"). Only that company's own words are read.
 */
export function signsInQuote(
  quote: string,
  profile: OfferProfile,
  playbook: Playbook,
  now: Date,
): SignalKindId[] {
  const context = { serviceNames: serviceNamesOf(profile), now };
  return profile.signals.filter((id) => signalKind(id).indicates(quote, playbook, context));
}

/** The page's sentences, for code to quote from. */
const sentencesOf = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= MAX_TRAIT_QUOTE);

/** Sentences after the quoted one that may carry its sign ("X is hiring" then "X is advertising for a…"). */
const NEAR_SENTENCES = 2;

/**
 * The sentence holding `quote`, or one of the next NEAR_SENTENCES, that says it; null when none does. Never a sentence
 * further away: on a round-up or a page of several stories, another company's sentence would give this one its sign.
 */
function sentenceSaying(text: string, quote: string, says: (sentence: string) => boolean): string | null {
  const sentences = sentencesOf(text);
  const want = fold(quote);
  const at = sentences.findIndex((s) => fold(s).includes(want) || want.includes(fold(s)));
  if (at < 0) return null;
  return sentences.slice(at, at + 1 + NEAR_SENTENCES).find(says) ?? null;
}

/** The traits a page really shows: one you look for, quoted from the page, and the quote says it. */
export function checkTraits(
  page: PageRead,
  said: SaidSigns["traits"],
  profile: OfferProfile,
): LeadEvidence[] {
  const kept: LeadEvidence[] = [];
  for (const trait of said) {
    const found = traitById(trait.id.trim().toLowerCase());
    const quote = trait.quote.trim();
    if (!found || !profile.traits.includes(found.id) || kept.some((e) => e.id === found.id)) continue;
    if (onPage(page.text, quote) && found.indicates(quote))
      kept.push({ kind: "trait", id: found.id, quote, url: page.url });
  }
  return kept;
}

/** A sentence longer than this isn't kept as a trait's quote. */
const MAX_TRAIT_QUOTE = 300;

/**
 * The traits a page shows, found by code (2.6): each trait you look for, quoted with the first sentence of the page
 * whose words say it. No model is asked: the trait checks are code anyway, so asking the Checker to quote them only
 * made its task longer.
 */
export function findTraits(page: PageRead, profile: OfferProfile): LeadEvidence[] {
  const sentences = sentencesOf(page.text);
  const kept: LeadEvidence[] = [];
  for (const id of profile.traits) {
    const trait = traitById(id);
    const quote = trait && sentences.find((s) => trait.indicates(s));
    if (trait && quote) kept.push({ kind: "trait", id: trait.id, quote, url: page.url });
  }
  return kept;
}

/** Traits from the Checker's quotes and from code, one of each. */
export function traitsOf(page: PageRead, said: SaidSigns["traits"], profile: OfferProfile): LeadEvidence[] {
  const byCode = findTraits(page, profile);
  return [...byCode, ...checkTraits(page, said, profile).filter((e) => !byCode.some((x) => x.id === e.id))];
}

/** A lead in the making: what was found, before it is scored. */
export interface Draft {
  company: string;
  domain: string | null;
  /** The first page or record read for it. */
  url: string;
  readBy: JobReader;
  facts: ClientFact[];
  signals: LeadSignal[];
  evidence: LeadEvidence[];
  records: LeadRecord[];
  contacts: ContactRoute[];
  ownSite: boolean;
  summary: string;
  /** The text of every page and record read for it, for the warnings. */
  pages: string[];
  /** It came as a tender or a "seeking a provider" post. */
  asking: boolean;
}

export interface BuildContext {
  profile: OfferProfile;
  playbook: Playbook;
  requirements: FitRequirement[];
  verdicts: ClaimedVerdict[];
  now: Date;
}

/** A sign weaker than this now (an undated new-company line, a faded one) doesn't make a lead "with signs". */
export const WEAK_SIGN = 0.3;

/**
 * Asking now when it asked or shows an asking sign, with signs when it shows another sign of some strength, else a
 * quiet fit. A company whose signs are all weak (undated, or faded) is a quiet fit: it must clear the quiet bar and is
 * capped as one, instead of one undated "Registered in England" line taking it past every check (1.2).
 */
export function kindOf(draft: Pick<Draft, "asking" | "signals">, now: Date = new Date()): LeadKind {
  if (draft.asking || draft.signals.some((s) => s.kind === "asking")) return "asking";
  return draft.signals.some((s) => signalStrength(s, now) >= WEAK_SIGN) ? "signs" : "quiet";
}

export interface Scored {
  kind: LeadKind;
  fit: FitLine[];
  score: number;
  capped: string | null;
  warnings: Lead["warnings"];
}

/** The lead's kind, fit lines, score and warnings, all by code. */
export function scoreDraft(draft: Draft, context: BuildContext): Scored {
  const kind = kindOf(draft, context.now);
  const fit = buildFit(context.requirements, context.verdicts, draft.facts, context.profile, {
    incorporated: draft.records.find((r) => r.incorporated)?.incorporated ?? null,
    signals: draft.signals,
    now: context.now,
  });
  const { score, capped } = scoreLead({
    kind,
    fit,
    signals: draft.signals,
    evidence: draft.evidence.length,
    contacts: draft.contacts.length,
    excluded: excludedBy(draft.facts, context.profile),
    now: context.now,
  });
  const warnings = leadWarnings({
    facts: draft.facts,
    signals: draft.signals,
    records: draft.records,
    contacts: draft.contacts,
    pages: draft.pages.join("\n\n"),
    playbook: context.playbook,
    now: context.now,
  });
  return { kind, fit, score, capped, warnings };
}

/** A new lead for the board from a draft. */
export function toLead(draft: Draft, scored: Scored, meta: { id: string; scan: number }, now: Date): Lead {
  const at = now.toISOString();
  return {
    id: meta.id,
    kind: scored.kind,
    company: draft.company,
    domain: draft.domain,
    url: draft.url,
    site: siteOf(draft.url),
    readBy: draft.readBy,
    foundAt: at,
    updatedAt: at,
    scan: meta.scan,
    column: "new",
    facts: draft.facts,
    signals: draft.signals,
    evidence: draft.evidence,
    records: draft.records,
    contacts: draft.contacts,
    fit: scored.fit,
    score: scored.score,
    ownSite: draft.ownSite,
    summary: draft.summary.slice(0, 300),
    warnings: scored.warnings,
    watch: scored.kind === "quiet",
    checkedAt: at,
    movedUp: null,
    reaction: null,
    reason: null,
    note: "",
  };
}

/**
 * A known lead with what was just found added: new signs, evidence, records and contacts, and the score worked out
 * again (signs fade, so a re-score can lower it). A quiet fit that shows a new sign moves up, and the card says what
 * changed. Returns the new signs (none: nothing changed but the check time).
 */
export function mergeIntoLead(lead: Lead, found: Partial<Draft>, context: BuildContext): LeadSignal[] {
  const fresh = newSignals(lead, found.signals ?? []);
  const key = (e: { kind: string; id: string }) => `${e.kind}|${e.id}`;
  const evidence = (found.evidence ?? []).filter((e) => !lead.evidence.some((x) => key(x) === key(e)));
  const records = (found.records ?? []).filter(
    (r) => !lead.records.some((x) => x.register === r.register && x.id === r.id),
  );
  const contacts = (found.contacts ?? []).filter(
    (c) => !lead.contacts.some((x) => x.kind === c.kind && x.value === c.value),
  );
  const wasQuiet = lead.kind === "quiet";
  lead.signals = [...lead.signals, ...fresh];
  lead.evidence = [...lead.evidence, ...evidence];
  lead.records = [...lead.records, ...records];
  lead.contacts = [...lead.contacts, ...contacts];
  if (found.ownSite) lead.ownSite = true;
  if (!lead.domain && found.domain) lead.domain = found.domain;
  for (const fact of found.facts ?? [])
    if (fact.value !== null && clientFact(lead.facts, fact.name) === null)
      lead.facts = lead.facts.map((f) => (f.name === fact.name ? fact : f));
  const scored = scoreDraft(
    {
      company: lead.company,
      domain: lead.domain,
      url: lead.url,
      readBy: lead.readBy,
      facts: lead.facts,
      signals: lead.signals,
      evidence: lead.evidence,
      records: lead.records,
      contacts: lead.contacts,
      ownSite: lead.ownSite,
      summary: lead.summary,
      pages: found.pages ?? [],
      asking: lead.kind === "asking" || !!found.asking,
    },
    {
      ...context,
      verdicts:
        // Lines the app wrote are worked out again by code, not passed off as the Checker's words.
        context.verdicts.length > 0
          ? context.verdicts
          : lead.fit.filter((line) => !line.byCode).map(toVerdict(context.requirements)),
    },
  );
  lead.kind = scored.kind;
  lead.fit = scored.fit;
  lead.score = scored.score;
  if (found.pages && found.pages.length > 0) lead.warnings = scored.warnings;
  const at = context.now.toISOString();
  lead.checkedAt = at;
  if (fresh.length > 0) {
    lead.updatedAt = at;
    if (wasQuiet && lead.kind !== "quiet") {
      lead.movedUp = movedUpText(fresh);
      lead.watch = false;
    }
  }
  return fresh;
}

/** A fit line as the Checker's verdict again, so a re-score keeps what the Checker said. */
const toVerdict =
  (requirements: FitRequirement[]) =>
  (line: FitLine): ClaimedVerdict => ({
    id: requirements.find((r) => r.text === line.requirement)?.id ?? "",
    verdict: line.verdict,
    reason: line.reason,
  });
