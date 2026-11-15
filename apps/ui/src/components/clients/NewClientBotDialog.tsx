import { Handshake, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button, cn } from "@mrog/ui-kit";

import { useBots } from "../../hooks/bots";
import { useCreateClientBot } from "../../hooks/clients";
import { useUi } from "../../state";
import { Modal } from "../Modal";
import { ModelSelect } from "../ModelSelect";

/** Room for "<name> Visual helper" in a 60-character bot name. */
const MAX_NAME = 60 - " Visual helper".length;

const defaultName = (taken: string[]) => {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = n === 1 ? "Client Bot" : `Client Bot ${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
};

/** New Client Bot: it asks what you sell and who to, then finds businesses that may need it when you ask. */
export function NewClientBotDialog() {
  const setOverlay = useUi((state) => state.setOverlay);
  const create = useCreateClientBot();
  const { data: bots } = useBots();
  const names = useMemo(() => (bots ?? []).map((bot) => bot.name), [bots]);
  const [name, setName] = useState(() => defaultName(names));
  const [edited, setEdited] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const suggested = defaultName(names);
  if (!edited && name !== suggested) setName(suggested);
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const trimmed = name.trim();
  const problem = !trimmed
    ? "Give it a name."
    : trimmed.length > MAX_NAME
      ? `Use up to ${MAX_NAME} characters.`
      : names.some((other) => other.toLowerCase() === trimmed.toLowerCase())
        ? "A bot with that name already exists."
        : null;

  const submit = () => {
    if (problem || create.isPending) return;
    create.mutateAsync({ name: trimmed, model }).then(
      ({ bot }) => {
        const ui = useUi.getState();
        ui.select(bot.threadId);
        if (open.current) ui.setOverlay(null);
      },
      (error: Error) => {
        if (!open.current) useUi.getState().notify(`Couldn't create the Client Bot: ${error.message}`);
      },
    );
  };

  return (
    <Modal title="New Client Bot" onClose={() => setOverlay(null)} className="max-w-lg">
      <form
        className="flex flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-4 p-5">
          <p className="text-[13px] text-ink-2">
            It asks what you sell and who your ideal client is, then looks when you tell it to: for businesses
            asking for a provider, ones showing signs they may need you (hiring, opening a new site), and good
            fits from official registers. Every fact is checked against the page or record it came from, and
            nothing is ever sent for you. Your profile and lists stay on this computer.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-[13px] font-medium">
              <Handshake size={14} className="text-ink-3" /> Name
            </span>
            <input
              value={name}
              maxLength={MAX_NAME}
              onChange={(event) => {
                setEdited(true);
                if (create.error) create.reset();
                setName(event.target.value);
              }}
              className={cn(
                "h-8 rounded-lg border border-border bg-bg px-2.5 text-[13px] outline-none focus:border-accent",
              )}
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">Model</span>
            <ModelSelect value={model} onChange={setModel} label="Client Bot's model" className="h-8" />
            <span className="text-xs text-ink-3">
              Its whole team uses it. A model that can see pictures (like qwen3.5:9b) also lets it read pages
              that only work in a browser.
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3 border-t border-border px-5 py-3">
          <span className="min-w-0 flex-1 text-xs text-ink-3" aria-live="polite">
            {create.error ? (
              <span className="text-danger">{create.error.message}</span>
            ) : (
              (problem ?? "Ready when you are.")
            )}
          </span>
          <Button type="button" variant="ghost" onClick={() => setOverlay(null)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={Boolean(problem) || create.isPending}>
            {create.isPending ? <Loader2 size={14} className="animate-spin" /> : <Handshake size={14} />}
            Create Client Bot
          </Button>
        </div>
      </form>
    </Modal>
  );
}
