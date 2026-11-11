import { ImageIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@mrog/ui-kit";

import { imageHost, isAppOwnImage } from "../../lib/images";

/**
 * An image in bot text. A web address is not fetched until the user asks: the address can carry what was said in the
 * chat, and a page the bot read could have told it to show one.
 */
export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!src) return null;
  const label = alt?.trim() || "image";
  if (failed) return <span className="text-ink-3">[{label}]</span>;
  if (loaded || isAppOwnImage(src))
    return (
      <img
        src={src}
        alt={label}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  const host = imageHost(src);
  return (
    <span className="my-1 inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[13px]">
      <ImageIcon size={14} className="shrink-0 text-ink-3" />
      <span className="min-w-0 truncate text-ink-2">{host ? `Image from ${host}` : `Image: ${label}`}</span>
      <Button size="sm" type="button" onClick={() => setLoaded(true)}>
        Load image
      </Button>
    </span>
  );
}
