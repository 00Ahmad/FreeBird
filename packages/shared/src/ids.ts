import { z } from "zod";

/** Prefixed random IDs ("bot_…", "evt_…") so an ID's kind is readable in logs and URLs. */
export const ID_PREFIXES = [
  "bot",
  "thr",
  "msg",
  "evt",
  "rtn",
  "apr",
  "run",
  "mem",
  "skl",
  "con",
  "vlt",
  "lib",
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export const idSchema = (prefix: IdPrefix) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{32}$`), `Expected a ${prefix}_ id`);

export const BotId = idSchema("bot");
export const EventId = idSchema("evt");
export const ThreadId = idSchema("thr");
export const MessageId = idSchema("msg");
