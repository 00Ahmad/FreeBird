import type { PageRead } from "@mrog/jobs";
import type { ContactRoute } from "@mrog/shared";

/**
 * The ways to reach a company, found by code on the pages read: never a model's guess, never a made-up address.
 * Company-level routes only: a business inbox (hello@, sales@), the main phone line, the contact page. An address
 * that looks like a person's (jane.smith@), a free-provider address and a mobile number are left out: they are
 * personal data.
 */

export const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "live.co.uk",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "aol.com",
  "btinternet.com",
  "sky.com",
  "talktalk.net",
  "virginmedia.com",
  "protonmail.com",
  "proton.me",
  "gmx.com",
  "mail.com",
]);

/** The local parts of a business's shared inboxes. */
const BUSINESS_INBOXES =
  /^(hello|hi|info|information|contact|contactus|contact-us|enquiries|enquiry|inquiries|inquiry|sales|office|admin|team|support|help|hr|people|finance|accounts|accounting|bookings|booking|reservations|press|media|marketing|studio|mail|general|reception|business|newbusiness|new\.business|partnerships|partners|operations|ops|service|services|customerservice|customers|orders|projects|work|careers|jobs)$/;

const EMAIL = /\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)+)\b/g;
/** A phone number written next to a word that says it is one. */
const PHONE = /(?:\btel(?:ephone)?|\bphone|\bcall(?: us)?(?: on)?|\bt)\s*[:.]?\s*(\+?\d[\d ()-]{8,16}\d)/gi;
/** UK mobiles: likely a person's own. */
const MOBILE = /^(\+?44\s?7|07)/;
const CONTACT_PAGE =
  /\/(contact|contact-us|contactus|get-in-touch|enquir|talk-to-us|reach-us)(\.html?|\/|$)/i;
const CONTACT_WORDS = /^(contact|contact us|get in touch|enquire|enquiries|talk to us)$/i;

const pathOf = (raw: string) => {
  try {
    return new URL(raw).pathname;
  } catch {
    return "";
  }
};

const hostOf = (raw: string) => {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** Whether an email address is a business's shared inbox on its own domain. */
export function isBusinessInbox(local: string, domain: string): boolean {
  return !FREE_EMAIL_DOMAINS.has(domain.toLowerCase()) && BUSINESS_INBOXES.test(local.toLowerCase());
}

/** Whether an email's domain is this company's: the same domain, or one inside the other (mail.brightside.co.uk). */
const ownDomain = (domain: string, own: readonly string[]) =>
  own.some((d) => d && (domain === d || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`)));

/**
 * The company-level contact routes on a page: at most one contact page, two inboxes and one phone line. An inbox is
 * kept only on the site's own domain (or `domain`, the company's known one): a footer's "Site by Pixel Agency
 * hello@pixelagency.com" is the web designer's, not the company's (1.6).
 */
export function findContacts(page: PageRead, domain: string | null = null): ContactRoute[] {
  const routes: ContactRoute[] = [];
  const host = hostOf(page.url);
  const own = [host, domain?.toLowerCase().replace(/^www\./, "") ?? ""];
  const link = page.links.find(
    (l) => hostOf(l.url) === host && (CONTACT_PAGE.test(pathOf(l.url)) || CONTACT_WORDS.test(l.text.trim())),
  );
  if (CONTACT_PAGE.test(pathOf(page.url)))
    routes.push({ kind: "contact_page", value: page.url, url: page.url });
  else if (link) routes.push({ kind: "contact_page", value: link.url, url: page.url });
  const inboxes = new Set<string>();
  for (const m of page.text.matchAll(EMAIL)) {
    const address = `${m[1]}@${m[2]}`.toLowerCase();
    if (
      inboxes.size < 2 &&
      isBusinessInbox(m[1]!, m[2]!) &&
      ownDomain(m[2]!.toLowerCase(), own) &&
      !inboxes.has(address)
    )
      inboxes.add(address);
  }
  for (const address of inboxes) routes.push({ kind: "email", value: address, url: page.url });
  for (const m of page.text.matchAll(PHONE)) {
    const number = m[1]!.replace(/\s+/g, " ").trim();
    if (MOBILE.test(number.replace(/[ ()-]/g, ""))) continue;
    routes.push({ kind: "phone", value: number, url: page.url });
    break;
  }
  return routes;
}

/** The routes of several pages together, without repeats (by kind and value). */
export function mergeContacts(...lists: ContactRoute[][]): ContactRoute[] {
  const seen = new Set<string>();
  return lists.flat().filter((route) => {
    const key = `${route.kind}|${route.value.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
