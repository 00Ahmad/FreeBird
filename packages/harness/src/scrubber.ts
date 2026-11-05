/**
 * Takes the user's own secrets out of text before it is shown to a model, saved in a chat, or written to the event log:
 * API keys, saved passwords, card numbers, app sign-in tokens. Unlike the event log's pattern-based redaction, this
 * knows the actual values, so it also catches a password that looks like an ordinary word.
 *
 * Values are matched as plain text (never turned into a pattern), in the forms they tend to turn up in: as typed,
 * percent-encoded in an address, base64 in an `Authorization: Basic` header, escaped inside JSON, and a card number
 * with or without spaces and dashes. Short values are left alone: replacing every "1234" or "admin" would wreck
 * ordinary text, and they are not what leaks.
 */

/** Values shorter than this are not scrubbed. */
export const MIN_SECRET_LENGTH = 8;
export const HIDDEN = "[hidden]";

/** A secret the scrubber should know about. */
export type SecretValue =
  | { kind: "plain"; value: string }
  /** A login: the password, and the pair as it appears in a Basic auth header. */
  | { kind: "login"; username: string; password: string }
  | { kind: "card"; number: string };

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** The forms one value is looked for in. */
export function secretForms(secret: SecretValue): string[] {
  const forms: string[] = [];
  const add = (value: string) => {
    // Too short to scrub as written, so its other forms are left alone too.
    if (value.length < MIN_SECRET_LENGTH) return;
    forms.push(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) forms.push(encoded);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) forms.push(escaped);
    forms.push(base64(value), base64(value).replace(/=+$/, ""));
  };
  if (secret.kind === "plain") add(secret.value);
  else if (secret.kind === "login") {
    add(secret.password);
    if (secret.username && secret.password.length >= MIN_SECRET_LENGTH)
      forms.push(base64(`${secret.username}:${secret.password}`));
  } else {
    const digits = secret.number.replace(/\D/g, "");
    if (digits.length >= 12) {
      const groups = digits.match(/.{1,4}/g) ?? [digits];
      forms.push(digits, groups.join(" "), groups.join("-"));
    }
  }
  return forms;
}

export class SecretScrubber {
  /** Longest first, so a value that contains another is replaced whole. */
  private forms: string[] = [];

  constructor(private readonly source: () => SecretValue[]) {}

  /** Reads the secrets again (after one was added, changed or removed). Never throws: an unreadable keychain scrubs nothing. */
  refresh(): void {
    let secrets: SecretValue[] = [];
    try {
      secrets = this.source();
    } catch (error) {
      console.warn("[scrubber] could not read the secrets", (error as Error).message);
    }
    this.forms = [...new Set(secrets.flatMap(secretForms))]
      .filter((form) => form.length >= MIN_SECRET_LENGTH)
      .toSorted((a, b) => b.length - a.length);
  }

  get size(): number {
    return this.forms.length;
  }

  scrub(text: string): string {
    if (this.forms.length === 0 || !text) return text;
    let out = text;
    for (const form of this.forms) if (out.includes(form)) out = out.split(form).join(HIDDEN);
    return out;
  }
}
