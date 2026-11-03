import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@mrog/ui-kit";

import { pushLayer } from "../lib/layers";

export type MenuEntry = { label: string; icon?: ReactNode; danger?: boolean; onSelect(): void } | "separator";

interface ContextMenuProps {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose(): void;
}

export function ContextMenu({ x, y, entries, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
    menu.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [x, y]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    // On the layer stack, so Escape in a menu inside a dialog closes the menu, not the dialog.
    const pop = pushLayer(onClose);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      pop();
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      style={position}
      className="fixed z-50 min-w-52 rounded-xl border border-border bg-surface p-1 shadow-pop"
    >
      {entries.map((entry, index) =>
        entry === "separator" ? (
          <div key={`sep-${index}`} role="separator" className="mx-2 my-1 h-px bg-border" />
        ) : (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none",
              "hover:bg-hover focus-visible:bg-hover",
              entry.danger ? "text-danger" : "text-ink",
            )}
          >
            {entry.icon && (
              <span className="flex size-4 items-center justify-center text-ink-2">{entry.icon}</span>
            )}
            {entry.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
