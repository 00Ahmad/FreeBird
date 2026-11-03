import { ArrowUp, ImagePlus, Square, X } from "lucide-react";
import { useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";

import { MAX_IMAGE_BYTES, type SendMessageInput } from "@mrog/shared";
import { cn, IconButton } from "@mrog/ui-kit";

type Image = NonNullable<SendMessageInput["images"]>[number];
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const COMPOSER_ID = "composer";

interface ComposerProps {
  placeholder: string;
  busy: boolean;
  disabled?: boolean;
  onSend(input: SendMessageInput): Promise<unknown>;
  onStop(): void;
  /** Extra buttons (voice, skills) from later phases. */
  tools?: ReactNode;
  /** Controlled text, for features that insert into the composer (mentions, skills, dictation). */
  text: string;
  onText(text: string): void;
  onKeyDown?(event: KeyboardEvent<HTMLTextAreaElement>): boolean | void;
  /** Shown above the input: reply chip, mention/skill suggestions. */
  above?: ReactNode;
}

async function readImage(file: File): Promise<Image | string> {
  if (!IMAGE_TYPES.has(file.type)) return `${file.name}: only PNG, JPEG, WebP or GIF images can be attached.`;
  if (file.size > MAX_IMAGE_BYTES) return `${file.name} is larger than 5 MB.`;
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buffer.length; i += 0x8000)
    binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return { mediaType: file.type as Image["mediaType"], data: btoa(binary) };
}

export function Composer(props: ComposerProps) {
  const { placeholder, busy, disabled, onSend, onStop, tools, text, onText: setText } = props;
  const [images, setImages] = useState<Image[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFiles = async (files: Iterable<File>) => {
    setError(null);
    for (const file of files) {
      const result = await readImage(file);
      if (typeof result === "string") setError(result);
      else setImages((current) => (current.length >= 4 ? current : [...current, result]));
    }
  };

  const send = async () => {
    if (sending || disabled || (!text.trim() && images.length === 0)) return;
    setSending(true);
    setError(null);
    try {
      await onSend({ text: text.trim(), ...(images.length ? { images } : {}) });
      setText("");
      setImages([]);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSending(false);
      area.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (props.onKeyDown?.(event)) return;
    if (
      event.key === "Enter" &&
      (!event.shiftKey || event.metaKey || event.ctrlKey) &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void send();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (files.length) {
      event.preventDefault();
      void addFiles(files);
    }
  };

  const canSend = !disabled && !sending && (text.trim().length > 0 || images.length > 0);

  return (
    <div className="shrink-0 px-5 pb-4">
      <div className="mx-auto max-w-3xl">
        {error && <p className="mb-1.5 px-1 text-xs text-danger">{error}</p>}
        {props.above}
        <div
          className="rounded-2xl border border-border bg-surface shadow-sm focus-within:border-accent/60"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void addFiles(event.dataTransfer.files);
          }}
        >
          {images.length > 0 && (
            <div className="flex gap-2 px-3 pt-3">
              {images.map((image, index) => (
                <div key={index} className="relative">
                  <img
                    src={`data:${image.mediaType};base64,${image.data}`}
                    alt=""
                    className="size-16 rounded-lg border border-border object-cover"
                  />
                  <button
                    type="button"
                    aria-label="Remove image"
                    onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                    className="absolute -top-1.5 -right-1.5 rounded-full bg-ink p-0.5 text-bg"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            id={COMPOSER_ID}
            ref={area}
            rows={1}
            value={text}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={placeholder}
            aria-label={placeholder}
            className="block max-h-56 min-h-11 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[14.5px] outline-none [field-sizing:content] placeholder:text-ink-3 disabled:opacity-60"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            <IconButton label="Attach image" onClick={() => fileInput.current?.click()} disabled={disabled}>
              <ImagePlus size={17} />
            </IconButton>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(event) => {
                void addFiles(event.target.files ?? []);
                event.target.value = "";
              }}
            />
            {tools}
            <div className="flex-1" />
            {busy && (
              <IconButton label="Stop" onClick={onStop} className="bg-hover text-ink">
                <Square size={13} className="fill-current" />
              </IconButton>
            )}
            <button
              type="button"
              aria-label="Send"
              title="Send (Enter)"
              onClick={() => void send()}
              disabled={!canSend}
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-full transition-colors",
                canSend ? "bg-accent text-accent-ink hover:bg-accent-hover" : "bg-hover text-ink-3",
              )}
            >
              <ArrowUp size={17} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
