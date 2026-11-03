import { z } from "zod";

/** What the app and bots may see about a vault item; secret fields stay in the OS keychain. */
export const VaultItem = z.object({
  id: z.string(),
  kind: z.enum(["login", "card", "contact"]),
  label: z.string(),
  website: z.string().nullable(),
  username: z.string().nullable(),
  last4: z.string().nullable(),
  /** Logins only: also offered on the site's subdomains (e.g. accounts.example.com), not just the site itself. */
  subdomains: z.boolean().optional(),
  /** Free text the bot uses when picking an entry. */
  hints: z.string(),
  createdAt: z.iso.datetime(),
});
export type VaultItem = z.infer<typeof VaultItem>;

const hints = z.string().max(500).optional();

export const NewVaultItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("login"),
    website: z.string().trim().min(1).max(300),
    username: z.string().trim().min(1).max(300),
    password: z.string().min(1).max(1000),
    subdomains: z.boolean().optional(),
    hints,
  }),
  z.object({
    kind: z.literal("card"),
    name: z.string().trim().min(1).max(100),
    number: z.string().regex(/^[\d ]{12,23}$/, "Card number"),
    expiry: z.string().regex(/^(0[1-9]|1[0-2])\/\d{2}$/, "MM/YY"),
    cvc: z.string().regex(/^\d{3,4}$/),
    hints,
  }),
  z.object({
    kind: z.literal("contact"),
    name: z.string().trim().min(1).max(100),
    email: z.string().max(200).optional(),
    phone: z.string().max(50).optional(),
    address: z.string().max(500).optional(),
    hints,
  }),
]);
export type NewVaultItem = z.infer<typeof NewVaultItem>;

export const ImportCsvInput = z.object({
  csv: z
    .string()
    .min(1)
    .max(5 * 1024 * 1024),
});

/** Environment variable names a login is handed to commands under, e.g. GITHUB_COM_USERNAME. */
export function loginEnvNames(website: string): { username: string; password: string } {
  const host = website.replace(/^https?:\/\//, "").split("/")[0] ?? website;
  const base =
    host
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "LOGIN";
  return { username: `${base}_USERNAME`, password: `${base}_PASSWORD` };
}

export const ComputerStatus = z.object({
  docker: z.object({ available: z.boolean(), version: z.string().nullable(), error: z.string().nullable() }),
  image: z.string(),
});
export type ComputerStatus = z.infer<typeof ComputerStatus>;

export const BotComputer = z.object({
  state: z.enum(["none", "starting", "running", "stopped", "error"]),
  /** Where the desktop's web view listens on this computer. */
  url: z.string().nullable(),
  error: z.string().nullable(),
});
export type BotComputer = z.infer<typeof BotComputer>;

export const VoiceSettings = z.object({
  /** Provider id (an OpenAI-compatible one) and model for speech-to-text, e.g. "groq" + "whisper-large-v3". */
  sttProvider: z.string().nullable(),
  sttModel: z.string().nullable(),
});
export type VoiceSettings = z.infer<typeof VoiceSettings>;
