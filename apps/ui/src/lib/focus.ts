/** Where Tab goes next inside a dialog, so focus never leaves it. */

/** What can take focus with Tab, in the order the page lists it. */
export const FOCUSABLE =
  'a[href], button, input, select, textarea, summary, [contenteditable=""], [contenteditable="true"], [tabindex]';

/** The minimum of an element this needs, so the rule can be tested without a browser. */
export interface Focusable {
  disabled?: boolean;
  hidden?: boolean;
  tabIndex: number;
  /** `type` of an input; hidden inputs never take focus. */
  type?: string;
  /** Whether it takes up room on the page (display: none and detached nodes do not). */
  rendered: boolean;
  /** Inside something inert or `aria-hidden`. */
  blocked?: boolean;
}

/** Whether Tab can land on it. */
export function tabbable(element: Focusable): boolean {
  if (element.disabled || element.hidden || element.blocked || !element.rendered) return false;
  if (element.tabIndex < 0) return false;
  return element.type !== "hidden";
}

/** What can be typed into. */
export const FIELD = "input, textarea, select";

/**
 * Where a dialog starts: the first field among its tabbable elements (in page order), or the first of them when it
 * has no field. -1 when nothing can take focus. Only tabbable elements count, so a hidden file input or one with
 * tabindex -1 is never where focus lands.
 */
export function firstFocus(tabbables: readonly { field: boolean }[]): number {
  const field = tabbables.findIndex((element) => element.field);
  if (field >= 0) return field;
  return tabbables.length > 0 ? 0 : -1;
}

/**
 * The index to focus when Tab (or Shift+Tab) is pressed with focus at `current` among `count` tabbable elements, or
 * null to leave the browser to move focus on its own (it stays inside, in the middle of the list).
 *
 * `current` is -1 when focus is outside the dialog altogether (on the page behind it, or on nothing): Tab then goes to
 * the first element, Shift+Tab to the last. At either end focus wraps round. With nothing tabbable, `count` is 0 and
 * the answer is -1: keep focus on the dialog itself.
 */
export function nextFocus(count: number, current: number, backwards: boolean): number | null {
  if (count === 0) return -1;
  if (current === -1) return backwards ? count - 1 : 0;
  if (backwards && current === 0) return count - 1;
  if (!backwards && current === count - 1) return 0;
  return null;
}

/**
 * Whether nothing is in use, so something that appears may take focus: the page itself has it (`current` is null),
 * or the message box does and it is empty. A box with text in it means the user is typing, and their next Enter or
 * Space would land on whatever took focus.
 */
export function focusIsIdle(current: { id: string; value?: string } | null, composerId: string): boolean {
  if (!current) return true;
  return current.id === composerId && current.value === "";
}
