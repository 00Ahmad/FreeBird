/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev only: the harness URL when the UI runs in a plain browser. */
  readonly VITE_MROG_HARNESS_URL?: string;
  /** Dev only: the harness token when the UI runs in a plain browser. */
  readonly VITE_MROG_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /** Set by the Electron preload. */
  mrog?: {
    harness: { url: string; token: string };
    platform: string;
    /** The system folder dialog: the chosen path, or null when cancelled. Only the desktop shell has it. */
    pickFolder?: () => Promise<string | null>;
  };
}
