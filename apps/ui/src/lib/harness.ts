interface HarnessInfo {
  url: string;
  token: string;
}

/** The desktop preload provides the harness address; a plain browser in dev reads it from Vite env. */
export function harnessInfo(): HarnessInfo | null {
  if (window.mrog?.harness) return window.mrog.harness;
  const token = import.meta.env.VITE_MROG_TOKEN;
  if (!token) return null;
  return { url: import.meta.env.VITE_MROG_HARNESS_URL ?? window.location.origin, token };
}

export const isMac = () => (window.mrog?.platform ?? navigator.platform).toLowerCase().includes("mac");
