import { fold } from "@mrog/jobs";

import type { Trait } from "./types";

const REGULATED =
  /\bcqc\b|care quality commission|\bfca\b|financial conduct authority|regulated by|authorised and regulated|\bsra\b|solicitors regulation|ofsted|\bgdc\b|general dental council|\bgmc\b|\bhcpc\b|food hygiene rating|\bico\b registered|licensed by/;

export const regulated: Trait = {
  id: "regulated",
  label: "In a regulated industry",
  indicates: (quote) => REGULATED.test(fold(quote)),
};
