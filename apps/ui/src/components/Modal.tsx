import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn, IconButton } from "@mrog/ui-kit";

import { FOCUSABLE, nextFocus, tabbable } from "../lib/focus";
import { pushLayer } from "../lib/layers";

interface ModalProps {
  title: string;
  onClose(): void;
  children: ReactNode;
  className?: string;
  /** Hide the title bar (the content draws its own). */
  bare?: boolean;
}

/** What Tab can land on inside the dialog, in page order. */
function tabbableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) =>
    tabbable({
      disabled: (element as HTMLButtonElement).disabled,
      hidden: Boolean(element.hidden), // true, or "until-found"
      tabIndex: element.tabIndex,
      type: (element as HTMLInputElement).type,
      // offsetParent is null for display:none and detached nodes; position:fixed ones are rendered but report null,
      // so those are checked by their box.
      rendered: element.offsetParent !== null || element.getClientRects().length > 0,
      blocked: element.closest("[inert], [aria-hidden='true']") !== null,
    }),
  );
}

/**
 * Centered dialog. Focus starts inside and stays inside: Tab and Shift+Tab go round the dialog, never to the page
 * behind it. Escape (if it's on top) and the backdrop close it, and focus returns to where it was.
 */
export function Modal({ title, onClose, children, className, bare }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  // Callers pass a new onClose on every render; the effect below must run once, or focus jumps while typing.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = panel.current;
    // Start in the first field; the header's Close button only when there's nothing to type into.
    const first =
      root?.querySelector<HTMLElement>("input, textarea, select") ??
      root?.querySelector<HTMLElement>("button, [tabindex]");
    (first ?? root)?.focus();
    const layer = pushLayer(() => close.current());

    // Only the dialog on top owns the keyboard: a menu opened from inside it is a layer of its own, and so is a
    // dialog opened over it, so neither has its Tab taken.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented || event.isComposing || !root || !layer.isTop())
        return;
      const items = tabbableIn(root);
      const at = items.indexOf(document.activeElement as HTMLElement);
      const target = nextFocus(items.length, at, event.shiftKey);
      if (target === null) return; // in the middle of the dialog: the browser moves on by itself
      event.preventDefault();
      (target === -1 ? root : items[target])?.focus();
    };

    // Focus sent somewhere behind the dialog (by a script, or a click on the page) is brought back inside. A menu or
    // another dialog is not "behind": it has its own layer, or says it keeps focus. Clicking plain text inside the
    // dialog leaves focus on the page's body without a focusin, so selecting text to copy it is not disturbed; and
    // if focus did end up on the body (a button that removed itself), the next Tab starts from the top (above).
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!root || !target || !layer.isTop() || root.contains(target)) return;
      if (target.closest('[role="dialog"], [role="menu"], [data-keeps-focus]')) return;
      (tabbableIn(root)[0] ?? root).focus();
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      layer();
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-overlay p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // Focusable only by script: the fallback when the dialog has nothing to tab to.
        tabIndex={-1}
        className={cn(
          "flex max-h-full w-full max-w-lg flex-col rounded-2xl bg-surface shadow-pop outline-none",
          className,
        )}
      >
        {!bare && (
          <div className="flex items-center border-b border-border px-5 py-3">
            <h2 className="flex-1 text-[15px] font-semibold">{title}</h2>
            <IconButton label="Close" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
