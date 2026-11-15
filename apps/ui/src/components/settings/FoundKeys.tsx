import { KeyRound, Plus } from "lucide-react";

import type { FoundKey, ProviderView } from "@mrog/shared";
import { Button } from "@mrog/ui-kit";

import { useAddFoundKey, useFoundKeys } from "../../hooks/foundKeys";
import { addFoundLabel, foundKeyText, offeredKeys } from "../../lib/found-keys";

/** API keys already set as environment variables, each one click from being a provider. Never shows a key. */
export function FoundKeys({ providers }: { providers: ProviderView[] }) {
  const { data } = useFoundKeys();
  if (!data) return null;
  const offered = offeredKeys(data.found, providers);

  if (offered.length === 0)
    return (
      <p className="text-[12px] text-ink-3">
        API keys set as environment variables for your account appear here, ready to add. Set one for your
        account (not only in a terminal profile like .bashrc) and restart FreeBird, or paste the key with Add
        provider.
      </p>
    );

  return (
    <div className="flex flex-col gap-2">
      <div>
        <h4 className="text-[12.5px] font-medium text-ink-2">Found on this computer</h4>
        <p className="text-[12px] text-ink-3">Add copies the key into your system keychain.</p>
      </div>
      <ul className="flex flex-col gap-2">
        {offered.map((found) => (
          <FoundKeyRow key={found.preset} found={found} />
        ))}
      </ul>
    </div>
  );
}

function FoundKeyRow({ found }: { found: FoundKey }) {
  const add = useAddFoundKey();
  return (
    <li className="rounded-xl border border-dashed border-border px-3 py-2.5 text-[13px]">
      <div className="flex items-center gap-3">
        <KeyRound size={14} className="text-ink-3" aria-hidden />
        <span>{foundKeyText(found)}</span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="primary"
          aria-label={addFoundLabel(found)}
          disabled={add.isPending}
          onClick={() => add.mutate(found.preset)}
        >
          <Plus size={13} /> {add.isPending ? "Adding…" : "Add"}
        </Button>
      </div>
      {add.error && (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {add.error.message}
        </p>
      )}
    </li>
  );
}
