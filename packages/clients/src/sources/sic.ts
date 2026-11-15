import { fold, words } from "@mrog/jobs";

/**
 * UK industry codes (SIC 2007) for the industries people name, so a register can be searched by industry. A word not
 * here gives no codes, and the register is searched by place alone.
 */
const SIC: [RegExp, string[]][] = [
  [/restaurant|cafe|café|dining|eatery/, ["56101", "56102"]],
  [/takeaway|take-away|fast food/, ["56103"]],
  [/\bpubs?\b|\bbars?\b|nightclub/, ["56302"]],
  [/hotel|guest house|b&b|bed and breakfast/, ["55100", "55201"]],
  [/catering|caterer/, ["56210"]],
  [/construction|builders?|building contractor/, ["41201", "41202", "43999"]],
  [/plumb|heating engineer/, ["43220"]],
  [/electrician|electrical contractor/, ["43210"]],
  [/care home|nursing home|residential care/, ["87100", "87300"]],
  [/home care|domiciliary/, ["88100"]],
  [/nurser(y|ies)|childcare|child care/, ["88910"]],
  [/dentist|dental/, ["86230"]],
  [/\bgps?\b|doctors?|medical practice|clinic/, ["86210", "86900"]],
  [/physio|chiropract|osteopath|therap/, ["86900"]],
  [/\bvets?\b|veterinar/, ["75000"]],
  [/hair|salon|beauty|barber/, ["96020"]],
  [/\bgyms?\b|fitness|leisure centre/, ["93130"]],
  [/e-?commerce|online (shop|store|retail)/, ["47910"]],
  [/retail|shops?\b|stores?\b/, ["47190"]],
  [/software|saas|tech(nology)? (company|startup)|app compan/, ["62012", "62020", "62090"]],
  [/marketing|advertising agency/, ["73110"]],
  [/solicitor|law firm|legal/, ["69102"]],
  [/accountan|bookkeep/, ["69201", "69202"]],
  [/estate agen/, ["68310"]],
  [/letting|property management/, ["68320"]],
  [/architect/, ["71111"]],
  [/engineering consult/, ["71129"]],
  [/haulage|logistics|freight|courier/, ["49410", "53202"]],
  [/warehous/, ["52103"]],
  [/cleaning|cleaners/, ["81210"]],
  [/security (company|guards?|services)/, ["80100"]],
  [/recruitment|staffing/, ["78109"]],
  [/consultan/, ["70229"]],
  [/garage|car repair|mechanic/, ["45200"]],
  [/wholesale|distribut/, ["46900"]],
  [/events?|conference/, ["82302"]],
  [/training (company|provider)|tutoring|education provider/, ["85590"]],
  [/printing|printers?\b/, ["18129"]],
];

/** The codes for the industries, without repeats, at most 20. */
export function sicCodesFor(industries: readonly string[]): string[] {
  const codes = new Set<string>();
  for (const industry of industries) {
    const text = fold(industry);
    if (words(text).length === 0) continue;
    for (const [pattern, list] of SIC) if (pattern.test(text)) for (const code of list) codes.add(code);
  }
  return [...codes].slice(0, 20);
}

/** Which of your industries a company's codes belong to, for its record ("restaurants"), or null. */
export function industryForCodes(codes: readonly string[], industries: readonly string[]): string | null {
  return industries.find((industry) => sicCodesFor([industry]).some((code) => codes.includes(code))) ?? null;
}
