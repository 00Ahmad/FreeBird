import { cn } from "@mrog/ui-kit";

/** An on/off switch with a name for screen readers; the visible text next to it is up to the caller. */
export function Switch({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange(on: boolean): void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border border-border transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50",
        on ? "bg-accent" : "bg-hover",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-3.5 rounded-full transition-all",
          on ? "left-[18px] bg-accent-ink" : "left-0.5 bg-ink-3",
        )}
      />
    </button>
  );
}
