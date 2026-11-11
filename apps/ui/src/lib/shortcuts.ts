/** The parts of a keydown the global shortcuts look at, so the rules can be tested without a browser. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  getModifierState?(key: string): boolean;
}

export type Shortcut =
  | {
      type:
        | "palette"
        | "settings"
        | "details"
        | "back"
        | "forward"
        | "newBot"
        | "newGroup"
        | "apps"
        | "shortcuts"
        | "compact"
        | "findBot"
        | "composer";
    }
  | { type: "cycle"; backwards: boolean }
  /** `number` is the digit pressed, 1 to 9. */
  | { type: "select"; number: number }
  | { type: "step"; delta: 1 | -1 };

/**
 * What a keydown does for the whole window, or null when it is not a global shortcut.
 *
 * On Windows, AltGr is reported as Ctrl+Alt, with `key` the character it types: `[` and `]` are AltGr+8 and 9 on
 * German, Nordic and Portuguese keyboards, `{` is AltGr+B on Czech and Slovak ones. Those keystrokes are typing,
 * so they never count, and the shortcuts built on Ctrl need the Alt key to be up (Details is the one that uses it).
 */
export function globalShortcut(event: KeyLike, options: { mac: boolean; typing: boolean }): Shortcut | null {
  if (event.getModifierState?.("AltGraph")) return null;
  const { mac, typing } = options;
  const mod = (event.metaKey || event.ctrlKey) && (mac || !event.altKey);
  const key = event.key.toLowerCase();

  if (mod && key === "k") return { type: "palette" };
  if (mod && !event.shiftKey && event.key === ",") return { type: "settings" };

  // event.code for Alt combinations: on a Mac, Option turns the key into another character ("∫" for B).
  const details = mac
    ? event.metaKey && ((event.shiftKey && key === "i") || (event.altKey && event.code === "KeyB"))
    : event.ctrlKey && event.altKey && event.code === "KeyB";
  if (details) return { type: "details" };
  if (event.ctrlKey && event.key === "Tab") return { type: "cycle", backwards: event.shiftKey };
  if (mod && !event.shiftKey && (event.key === "[" || event.key === "]"))
    return { type: event.key === "[" ? "back" : "forward" };
  if (mod && !event.shiftKey && key === "n") return { type: "newBot" };
  if (mod && event.shiftKey && key === "n") return { type: "newGroup" };
  if (mod && event.shiftKey && key === "m") return { type: "apps" };
  if (mod && event.key === "/") return { type: "shortcuts" };
  if (mod && !event.shiftKey && key === "b") return { type: "compact" };
  if (mod && event.shiftKey && key === "f") return { type: "findBot" };
  // Not with Shift: Ctrl+Shift+I opens the developer tools.
  if (mod && !event.shiftKey && !event.altKey && key === "i") return { type: "composer" };
  if (mod && /^[1-9]$/.test(event.key)) return { type: "select", number: Number(event.key) };
  if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && !typing)
    return { type: "step", delta: event.key === "ArrowDown" ? 1 : -1 };
  return null;
}
