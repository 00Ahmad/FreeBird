import { fold } from "../text";
import type { WarningRule } from "./types";

/** Words real employers don't use: paying to start, chat-app interviews, money passing through your account. */
const SIGNS: [RegExp, string][] = [
  [
    /(pay|purchase|buy)\b.{0,30}\b(fee|starter kit|training|equipment)|(training|registration|starter) fee/,
    "asks you to pay",
  ],
  [
    /interview\b.{0,40}\b(telegram|whatsapp|signal|google hangouts)|(telegram|whatsapp)\b.{0,40}\binterview/,
    "interviews over a chat app",
  ],
  [
    /(receive|process|transfer)\b.{0,30}\b(payments?|funds|money)\b.{0,30}\b(your (own )?(bank )?account)/,
    "moves money through your account",
  ],
  [
    /unlimited (earning|income)|be your own boss|earn \$?\d+[,\d]* (a|per) (day|week) from home|no experience needed.{0,40}\bearn/,
    "promises easy money",
  ],
];

export const scamWording: WarningRule = {
  id: "scam-wording",
  check({ page }) {
    const text = fold(page);
    const found = SIGNS.filter(([pattern]) => pattern.test(text)).map(([, what]) => what);
    return found.length > 0 ? `Looks like a scam: ${found.join(", ")}.` : null;
  },
};
