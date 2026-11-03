import type { SettingsSection } from "../../state";

/** Settings pages in menu order; later phases register theirs here (and how to draw it in SettingsDialog). */
export const SETTINGS_PAGES: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "model", label: "Local model" },
  { id: "providers", label: "Models & Providers" },
  { id: "computer", label: "Computer" },
  { id: "browser", label: "Browser & search" },
  { id: "routines", label: "Routines" },
  { id: "apps", label: "Connect apps" },
  { id: "vault", label: "Vault" },
  { id: "voice", label: "Voice" },
  { id: "usage", label: "Usage" },
];
