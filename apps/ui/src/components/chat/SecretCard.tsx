import { CheckCircle2, LockKeyhole } from "lucide-react";
import { useState } from "react";

import type { MessagePart } from "@mrog/shared";
import { Button } from "@mrog/ui-kit";

import { api } from "../../lib/api";

type SecretPart = Extract<MessagePart, { type: "secret" }>;

/** Secure secret card: the value goes to the keychain and never into the chat or the model. */
export function SecretCard({ part, live }: { part: SecretPart; live: boolean }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const respond = async (decline: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/secret-requests/${part.requestId}`, {
        method: "POST",
        body: decline ? { name: part.name, decline: true } : { name: part.name, value },
      });
      setValue("");
    } catch (caught) {
      setError(caught instanceof Error ? "The secret was not saved. Try again." : String(caught));
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-xl border border-border bg-surface p-3 text-[13px]"
      role="group"
      aria-label="Secure secret"
    >
      <div className="flex items-center gap-2 font-medium">
        <LockKeyhole size={15} className="text-accent" />
        {part.name}
      </div>
      <p className="mt-0.5 text-ink-2">{part.reason}</p>
      {part.saved ? (
        <p className="mt-2 flex items-center gap-1.5 text-success">
          <CheckCircle2 size={13} /> Saved securely and kept private.
        </p>
      ) : part.expired ? (
        <p className="mt-2 text-ink-3">No longer waiting for this secret.</p>
      ) : live ? (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (value) void respond(false);
          }}
        >
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            aria-label={`Value for ${part.name}`}
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 font-mono outline-none focus:border-accent"
          />
          <Button size="sm" variant="primary" type="submit" disabled={busy || !value}>
            Save securely
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void respond(true)}>
            Skip
          </Button>
        </form>
      ) : (
        <p className="mt-2 text-ink-3">Not provided.</p>
      )}
      <p className="mt-2 text-[11px] text-ink-3">Stored securely, never shown to your Bot.</p>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
