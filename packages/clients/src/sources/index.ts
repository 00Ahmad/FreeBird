import type { OfferProfile } from "@mrog/shared";

import type { Playbook } from "../playbooks";
import { companiesHouse } from "./companies-house";
import { contractsFinder } from "./contracts-finder";
import { foodHygiene } from "./food-hygiene";
import type { Register } from "./types";

export type { Register, RegisterQuery, RegisterRecord, RegisterRequest } from "./types";
export { companiesHouse, companyProfile, companyRecord, nameSearch, parseItems } from "./companies-house";
export { foodHygiene, premisesByName, premisesCount, premisesFit, staffFromPremises } from "./food-hygiene";
export { leadRecord, recordFacts, recordPage, recordSignals, recordText } from "./record-page";
export { industryForCodes, sicCodesFor } from "./sic";

/** Every register, tenders first. */
export const REGISTERS: readonly Register[] = [contractsFinder, companiesHouse, foodHygiene];

/** The registers that can help with this profile. */
export const registersFor = (profile: OfferProfile, playbook: Playbook) =>
  REGISTERS.filter((register) => register.fits(profile, playbook));
