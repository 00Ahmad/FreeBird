import { Upload } from "lucide-react";
import { useState } from "react";

import { AVATAR_COLORS, AVATAR_SHAPES, type Avatar } from "@mrog/shared";
import { BotAvatar, Button, cn } from "@mrog/ui-kit";

import { useBots, useUpdateBot } from "../../hooks/bots";
import { useUi } from "../../state";
import { Modal } from "../Modal";

/** Shrinks an uploaded picture to a 256 px square so it stays small in the database. */
async function toAvatarImage(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("Use a PNG, JPEG or WebP image.");
  if (file.size > 25 * 1024 * 1024) throw new Error("Images must be under 25 MB.");
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  canvas
    .getContext("2d")!
    .drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  return canvas.toDataURL("image/jpeg", 0.85);
}

export function AvatarEditor({ botId }: { botId: string }) {
  const { data: bots } = useBots();
  const update = useUpdateBot();
  const setOverlay = useUi((state) => state.setOverlay);
  const bot = bots?.find((candidate) => candidate.id === botId);
  const [tab, setTab] = useState<"bot" | "upload">(bot?.avatar.image ? "upload" : "bot");
  const [draft, setDraft] = useState<Avatar | null>(bot?.avatar ?? null);
  const [error, setError] = useState<string | null>(null);
  if (!bot || !draft) return null;
  const close = () => setOverlay(null);

  return (
    <Modal title="Edit picture" onClose={close}>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex justify-center">
          <BotAvatar avatar={draft} size={96} />
        </div>
        <div className="flex gap-1 rounded-lg bg-hover p-1 text-[13px]" role="tablist">
          {(["bot", "upload"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "flex-1 rounded-md py-1",
                tab === id ? "bg-surface font-medium shadow-sm" : "text-ink-2",
              )}
            >
              {id === "bot" ? "Bot" : "Upload"}
            </button>
          ))}
        </div>
        {tab === "bot" ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-8 gap-1.5" role="radiogroup" aria-label="Shape">
              {AVATAR_SHAPES.map((shape) => (
                <button
                  key={shape}
                  type="button"
                  role="radio"
                  aria-checked={draft.shape === shape && !draft.image}
                  aria-label={shape}
                  onClick={() => setDraft({ shape, color: draft.color })}
                  className={cn(
                    "flex items-center justify-center rounded-lg p-1.5",
                    draft.shape === shape && !draft.image
                      ? "bg-selected ring-2 ring-accent"
                      : "hover:bg-hover",
                  )}
                >
                  <BotAvatar avatar={{ shape, color: draft.color }} size={28} />
                </button>
              ))}
            </div>
            <div className="flex justify-center gap-2" role="radiogroup" aria-label="Color">
              {AVATAR_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={draft.color === color}
                  aria-label={color}
                  onClick={() => setDraft({ shape: draft.shape, color })}
                  className={cn(
                    "size-7 rounded-full",
                    draft.color === color && "ring-2 ring-accent ring-offset-2 ring-offset-surface",
                  )}
                  style={{ background: `var(--mrog-avatar-${color})` }}
                />
              ))}
            </div>
          </div>
        ) : (
          <label
            className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-6 text-[13px] text-ink-2 hover:bg-hover"
            onDragOver={(event) => event.preventDefault()}
            onDrop={async (event) => {
              event.preventDefault();
              const file = event.dataTransfer.files[0];
              if (file)
                setDraft({
                  ...draft,
                  image: await toAvatarImage(file).catch((e: Error) => (setError(e.message), draft.image)),
                });
            }}
          >
            <Upload size={20} />
            Drag an image here or <span className="text-accent">browse files</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setError(null);
                try {
                  setDraft({ ...draft, image: await toAvatarImage(file) });
                } catch (caught) {
                  setError((caught as Error).message);
                }
              }}
            />
          </label>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => update.mutate({ id: bot.id, patch: { avatar: draft } }, { onSuccess: close })}
          >
            Set avatar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
