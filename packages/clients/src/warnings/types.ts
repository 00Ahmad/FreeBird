import type { ContactRoute, ClientFact, LeadRecord, LeadSignal } from "@mrog/shared";

import type { Playbook } from "../playbooks";

/** What a warning rule looks at: the lead's evidence and the pages it was read from. */
export interface LeadContext {
  facts: ClientFact[];
  signals: LeadSignal[];
  records: LeadRecord[];
  contacts: ContactRoute[];
  /** The text of the pages read for this lead, together. */
  pages: string;
  playbook: Playbook;
  now: Date;
}

/** One warning sign, one file each: a plain sentence, or null. */
export interface LeadWarningRule {
  id: string;
  check(lead: LeadContext): string | null;
}
