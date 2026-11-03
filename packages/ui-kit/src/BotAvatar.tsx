import type { Avatar, AvatarShape } from "@mrog/shared";

import { cn } from "./cn";

/** Shape outlines in a 40×40 box. Our own set; each face gets the same two eyes. */
const SHAPES: Record<AvatarShape, string> = {
  circle: "M20 2a18 18 0 1 1 0 36a18 18 0 1 1 0-36Z",
  squircle: "M20 2C33 2 38 7 38 20S33 38 20 38S2 33 2 20S7 2 20 2Z",
  hexagon: "M20 2L36 11V29L20 38L4 29V11Z",
  drop: "M20 2C27 10 36 17 36 25a16 13 0 0 1-32 0C4 17 13 10 20 2Z",
  burst:
    "M20 2l4.2 6.4 7.5-1.7-1.7 7.5L36.4 18.4 30 22.6l1.7 7.5-7.5-1.7L20 34.8l-4.2-6.4-7.5 1.7 1.7-7.5L3.6 18.4 10 14.2 8.3 6.7l7.5 1.7Z",
  leaf: "M6 34C4 16 16 4 36 4C36 24 24 36 6 34Z",
  moon: "M26 3A18 18 0 1 0 37 25A14 14 0 1 1 26 3Z",
  diamond: "M20 2L38 20L20 38L2 20Z",
};

/** Where the eyes sit, so they land inside every shape. */
const EYES: Record<AvatarShape, [number, number]> = {
  circle: [20, 18],
  squircle: [20, 18],
  hexagon: [20, 19],
  drop: [20, 24],
  burst: [20, 19],
  leaf: [19, 20],
  moon: [15, 18],
  diamond: [20, 19],
};

export interface BotAvatarProps {
  avatar: Avatar;
  size?: number;
  className?: string;
  title?: string;
}

export function BotAvatar({ avatar, size = 32, className, title }: BotAvatarProps) {
  if (avatar.image) {
    return (
      <img
        src={avatar.image}
        width={size}
        height={size}
        alt={title ?? ""}
        draggable={false}
        className={cn("shrink-0 rounded-[30%] object-cover", className)}
      />
    );
  }
  const [cx, cy] = EYES[avatar.shape];
  return (
    <svg
      viewBox="0 0 40 40"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <path d={SHAPES[avatar.shape]} fill={`var(--mrog-avatar-${avatar.color})`} />
      <ellipse cx={cx - 4.5} cy={cy} rx="2" ry="2.6" fill="var(--mrog-avatar-eye)" />
      <ellipse cx={cx + 4.5} cy={cy} rx="2" ry="2.6" fill="var(--mrog-avatar-eye)" />
    </svg>
  );
}
