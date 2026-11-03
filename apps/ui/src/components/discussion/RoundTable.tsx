import { Check, Pause } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Bot } from "@mrog/shared";
import { BotAvatar, cn } from "@mrog/ui-kit";

/** Where the bots sit, in viewBox units (0–100). */
const ORBIT = 36;
/** The table's rim. */
const TABLE = 23;
/** Angle left free around each seat so arrows stop short of the bots. */
const SEAT_GAP_DEG = 14;

export type SeatState = "speaking" | "spoke" | "waiting" | "idle";

export interface Seat {
  bot: Bot;
  role: string | null;
  state: SeatState;
  /** One line under a speaking bot ("Searching: …"). */
  activity?: string;
}

/** A small seeded random generator, so the decorative stars stay put between renders. */
function seeded(seed: number) {
  let value = seed;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

const polar = (deg: number, radius: number, cx = 50, cy = 50) => {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
};

/** "growth marketer — runs the trial…" → "Growth marketer": the label under a seat; the rest is in the tooltip. */
export function shortRole(role: string | null): string | null {
  if (!role) return null;
  const head = role.split(/\s[—–-]\s|[:;,.(]/)[0]!.trim();
  const words = head.split(/\s+/);
  const short = words.length > 4 ? `${words.slice(0, 4).join(" ")}…` : head;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** Side length of the largest square that fits the element. */
function useSquare() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      setSize(Math.floor(Math.min(width, height)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

/** A small network of connected points, like ideas being linked; sits in the middle of the table. */
export function IdeaNetwork({ className }: { className?: string }) {
  const network = useMemo(() => {
    const random = seeded(42);
    const points = Array.from({ length: 16 }, () => polar(random() * 360, 2 + random() * 10, 20, 13));
    const lines: [number, number][] = [];
    points.forEach((a, i) =>
      points.forEach((b, j) => {
        if (j > i && Math.hypot(a.x - b.x, a.y - b.y) < 8) lines.push([i, j]);
      }),
    );
    return { points, lines };
  }, []);
  return (
    <svg viewBox="0 0 40 26" className={cn("text-accent", className)} aria-hidden="true">
      {network.lines.map(([a, b], i) => (
        <line
          key={i}
          x1={network.points[a]!.x}
          y1={network.points[a]!.y}
          x2={network.points[b]!.x}
          y2={network.points[b]!.y}
          stroke="currentColor"
          strokeWidth="0.18"
          opacity="0.45"
        />
      ))}
      {network.points.map((point, i) => (
        <circle
          key={i}
          cx={point.x}
          cy={point.y}
          r={i % 5 === 0 ? 0.9 : 0.55}
          fill="currentColor"
          opacity={i % 5 === 0 ? 1 : 0.6}
          className="mrog-twinkle"
          style={{ animationDelay: `${(i * 0.37) % 4}s` }}
        />
      ))}
    </svg>
  );
}

/**
 * The bots seated around a glowing table, speaking order shown by arrows; the speaker glows. The middle holds
 * whatever the caller puts there (topic, status).
 */
export function RoundTable({ seats, paused, center }: { seats: Seat[]; paused: boolean; center: ReactNode }) {
  const { ref, size } = useSquare();
  const count = seats.length;
  const angleOf = (index: number) => -90 + (360 / Math.max(count, 1)) * index;

  const stars = useMemo(() => {
    const random = seeded(7);
    return Array.from({ length: 60 }, () => {
      const p = polar(random() * 360, 18 + random() * 31);
      return { ...p, r: 0.12 + random() * 0.3, delay: random() * 4 };
    });
  }, []);

  const seat = Math.max(42, size * 0.12);

  return (
    <div ref={ref} className="relative flex min-h-0 w-full flex-1 items-center justify-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full text-accent" aria-hidden="true">
          <defs>
            <radialGradient id="rt-halo">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
              <stop offset="50%" stopColor="currentColor" stopOpacity="0.04" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </radialGradient>
            <filter id="rt-blur" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="0.9" />
            </filter>
            {[
              ["rt-arrow", 3.2],
              ["rt-arrow-live", 3.8],
            ].map(([id, scale]) => (
              <marker
                key={id}
                id={String(id)}
                viewBox="0 0 6 6"
                refX="4"
                refY="3"
                markerWidth={scale}
                markerHeight={scale}
                orient="auto"
              >
                <path d="M0,0 L6,3 L0,6 z" fill="currentColor" />
              </marker>
            ))}
          </defs>

          <circle cx="50" cy="50" r="49" fill="url(#rt-halo)" />
          {stars.map((star, i) => (
            <circle
              key={i}
              cx={star.x}
              cy={star.y}
              r={star.r}
              fill="currentColor"
              className="mrog-twinkle"
              style={{ animationDelay: `${star.delay}s` }}
            />
          ))}

          {/* The table: a blurred glow rim, a crisp rim, an inner line and a slowly turning dashed ring. */}
          <circle
            cx="50"
            cy="50"
            r={TABLE}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            opacity="0.4"
            filter="url(#rt-blur)"
          />
          <circle
            cx="50"
            cy="50"
            r={TABLE}
            style={{ fill: "var(--mrog-surface)" }}
            stroke="currentColor"
            strokeWidth="0.45"
          />
          <circle
            cx="50"
            cy="50"
            r={TABLE - 2.2}
            fill="none"
            stroke="currentColor"
            strokeWidth="0.15"
            opacity="0.4"
          />
          <circle
            cx="50"
            cy="50"
            r={TABLE + 3}
            fill="none"
            stroke="currentColor"
            strokeWidth="0.25"
            strokeDasharray="0.6 1.6"
            opacity="0.5"
            className={paused ? undefined : "mrog-orbit"}
          />

          {/* Speaking order: an arrow from each seat to the next; the one into the speaker flows. */}
          {count > 1 &&
            seats.map((_, i) => {
              const from = polar(angleOf(i) + SEAT_GAP_DEG, ORBIT);
              const to = polar(angleOf(i + 1) - SEAT_GAP_DEG, ORBIT);
              const live = seats[(i + 1) % count]!.state === "speaking";
              return (
                <path
                  key={i}
                  d={`M ${from.x} ${from.y} A ${ORBIT} ${ORBIT} 0 0 1 ${to.x} ${to.y}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={live ? 0.5 : 0.3}
                  strokeDasharray="1.2 1.8"
                  opacity={live ? 1 : 0.35}
                  markerEnd={`url(#${live ? "rt-arrow-live" : "rt-arrow"})`}
                  className={live && !paused ? "mrog-flow" : undefined}
                />
              );
            })}
        </svg>

        <div className="absolute top-1/2 left-1/2 flex w-[40%] -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center">
          {center}
        </div>

        {seats.map((entry, i) => {
          const p = polar(angleOf(i), ORBIT);
          return <SeatView key={entry.bot.id} seat={entry} size={seat} x={p.x} y={p.y} paused={paused} />;
        })}
      </div>
    </div>
  );
}

function SeatView({
  seat,
  size,
  x,
  y,
  paused,
}: {
  seat: Seat;
  size: number;
  x: number;
  y: number;
  paused: boolean;
}) {
  const { bot, role, state, activity } = seat;
  const speaking = state === "speaking";
  // Seats in the top part of the ring put their name above, so it never runs into the table.
  const above = y < 40;
  const label = (
    <div className={cn("w-full text-center leading-tight", above ? "mb-1.5" : "mt-1.5")}>
      <div className={cn("truncate text-[13px] font-semibold", speaking && "text-accent")}>{bot.name}</div>
      {role && <div className="truncate text-[11px] text-ink-3">{shortRole(role)}</div>}
      {speaking && activity && (
        <div className="truncate text-[11px] font-medium text-success">{activity}</div>
      )}
    </div>
  );
  return (
    <div
      className={cn("absolute flex -translate-x-1/2 flex-col items-center", above && "-translate-y-full")}
      style={{ left: `${x}%`, top: `${y}%`, marginTop: above ? size / 2 : -size / 2, width: size * 2.2 }}
      title={role ? `${bot.name}: ${role}` : bot.name}
    >
      {above && label}
      <div
        className={cn(
          "relative flex shrink-0 items-center justify-center rounded-full border-2 bg-[radial-gradient(circle_at_50%_35%,color-mix(in_srgb,var(--mrog-accent)_16%,var(--mrog-surface)),var(--mrog-surface)_70%)] transition-all",
          speaking && "border-accent",
          speaking && !paused && "mrog-breathe",
          state === "spoke" &&
            "border-success shadow-[0_0_14px_color-mix(in_srgb,var(--mrog-success)_40%,transparent)]",
          (state === "waiting" || state === "idle") && "border-border opacity-80",
        )}
        style={{ width: size, height: size }}
      >
        <BotAvatar avatar={bot.avatar} size={Math.round(size * 0.62)} />
        {state === "spoke" && (
          <span className="absolute -right-0.5 -bottom-0.5 flex size-5 items-center justify-center rounded-full bg-success text-accent-ink">
            <Check size={12} strokeWidth={3} />
          </span>
        )}
        {speaking && paused && (
          <span className="absolute -right-0.5 -bottom-0.5 flex size-5 items-center justify-center rounded-full bg-warning text-accent-ink">
            <Pause size={11} strokeWidth={3} />
          </span>
        )}
      </div>
      {!above && label}
    </div>
  );
}
