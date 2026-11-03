import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn, IconButton } from "@mrog/ui-kit";

import { pushLayer } from "../lib/layers";

interface ModalProps {
  title: string;
  onClose(): void;
  children: ReactNode;
  className?: string;
  /** Hide the title bar (the content draws its own). */
  bare?: boolean;
}

/** Centered dialog with focus trapping-lite: Escape (if it's on top) and backdrop close it, focus starts inside. */
export function Modal({ title, onClose, children, className, bare }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  // Callers pass a new onClose on every render; the effect below must run once, or focus jumps while typing.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Start in the first field; the header's Close button only when there's nothing to type into.
    const first =
      panel.current?.querySelector<HTMLElement>("input, textarea, select") ??
      panel.current?.querySelector<HTMLElement>("button, [tabindex]");
    first?.focus();
    const pop = pushLayer(() => close.current());
    return () => {
      pop();
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
        className={cn(
          "flex max-h-full w-full max-w-lg flex-col rounded-2xl bg-surface shadow-pop",
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
