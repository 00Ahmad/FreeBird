import { KeyRound, Loader2, X } from "lucide-react";
import { useState } from "react";

import { LIST_NAMES, type Bot, type ClientProject, type ListName } from "@mrog/shared";
import { Button, cn } from "@mrog/ui-kit";

import {
  useAddToList,
  useClientKeys,
  useRemoveFromList,
  useSetClientKey,
  useSetLookalikes,
  useUpdateLookalike,
  useWatchList,
} from "../../hooks/clients";
import { LIST_LABELS } from "../../lib/clients";

const field = "rounded-lg border border-border bg-bg px-2.5 text-[13px] outline-none focus:border-accent";

/** A list's entries, shown and removable, and a box to paste more (or a CSV's text). */
function ListEditor({ bot, project, list }: { bot: Bot; project: ClientProject; list: ListName }) {
  const add = useAddToList(bot.id);
  const remove = useRemoveFromList(bot.id);
  const [text, setText] = useState("");
  const entries = project.lists[list];
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-[12.5px] font-medium">
        {LIST_LABELS[list]} <span className="text-ink-3">· {entries.length}</span>
      </h4>
      {entries.length > 0 && (
        <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto text-[12.5px]">
          {entries.map((entry) => (
            <li key={`${entry.name}|${entry.domain}`} className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate">
                {entry.name}
                {entry.domain && entry.domain !== entry.name && (
                  <span className="text-ink-3"> · {entry.domain}</span>
                )}
              </span>
              <button
                type="button"
                aria-label={`Remove ${entry.name}`}
                onClick={() => remove.mutate({ body: { list, entry } })}
                className="text-ink-3 hover:text-ink"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste names or web addresses, one per line (or a CSV)"
        className={cn(field, "py-1.5")}
      />
      <div className="flex items-center gap-2">
        <label className="cursor-pointer text-[12px] text-accent">
          Load a CSV file
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void file.text().then((content) => setText(content));
              e.target.value = "";
            }}
          />
        </label>
        <span className="flex-1" />
        <Button
          size="sm"
          disabled={!text.trim() || add.isPending}
          onClick={() => add.mutate({ body: { list, text } }, { onSuccess: () => setText("") })}
        >
          Add
        </Button>
      </div>
      {add.error && <p className="text-[12px] text-danger">{add.error.message}</p>}
    </section>
  );
}

/** Your lists (never shown as leads), lookalikes of your best clients, register keys and the watch list. */
export function ListsCard({ bot, project }: { bot: Bot; project: ClientProject }) {
  const keys = useClientKeys();
  const setKey = useSetClientKey();
  const learn = useSetLookalikes(bot.id);
  const updateLook = useUpdateLookalike(bot.id);
  const watchList = useWatchList(bot.id);
  const [key, setKeyText] = useState("");
  const [favourites, setFavourites] = useState("");
  const look = project.lookalikes;
  const [area, setArea] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4 p-4 text-[13px]">
      <p className="text-[12px] text-ink-3">
        These stay on this computer. A company on any list is never shown as a lead.
      </p>
      {LIST_NAMES.map((list) => (
        <ListEditor key={list} bot={bot} project={project} list={list} />
      ))}

      <section className="flex flex-col gap-1.5 rounded-xl border border-border p-3">
        <h4 className="flex items-center gap-1.5 text-[12.5px] font-medium">
          <KeyRound size={13} /> Companies House API key (UK)
        </h4>
        <p className="text-[12px] text-ink-3">
          Free from the Companies House developer site. It lets scans find companies that never posted
          anything, and learn lookalikes of your clients. Kept in your system keychain; it never reaches a
          model.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => setKeyText(e.target.value)}
            placeholder={keys.data?.companiesHouse ? "Saved: type a new one to replace it" : "Paste your key"}
            className={cn(field, "h-8 min-w-0 flex-1")}
          />
          <Button
            size="sm"
            disabled={!key.trim() || setKey.isPending}
            onClick={() =>
              setKey.mutate({ name: "companiesHouse", key: key.trim() }, { onSuccess: () => setKeyText("") })
            }
          >
            Save
          </Button>
          {keys.data?.companiesHouse && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setKey.mutate({ name: "companiesHouse", key: "" })}
            >
              Remove
            </Button>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-1.5 rounded-xl border border-border p-3">
        <h4 className="text-[12.5px] font-medium">Lookalikes of your best clients</h4>
        <p className="text-[12px] text-ink-3">
          Add about five clients you love. The bot looks them up in Companies House, works out what they
          share, and shows you before any scan uses it. They're added to your clients list.
        </p>
        <textarea
          rows={3}
          value={favourites}
          onChange={(e) => setFavourites(e.target.value)}
          placeholder="One company name per line"
          className={cn(field, "py-1.5")}
        />
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[12px] text-danger">{learn.error?.message}</span>
          <Button
            size="sm"
            disabled={!favourites.trim() || learn.isPending}
            onClick={() =>
              learn.mutate({ body: { text: favourites } }, { onSuccess: () => setFavourites("") })
            }
          >
            {learn.isPending && <Loader2 size={12} className="animate-spin" />} Learn
          </Button>
        </div>
        {look.matched.length > 0 && (
          <div className="text-[12px]">
            <p className="text-ink-3">Matched in Companies House (by name and place, checked by the app):</p>
            <ul className="mt-0.5 flex flex-col gap-0.5">
              {look.matched.map((match) => (
                <li key={match.id}>
                  {match.client} → {match.record} <span className="text-ink-3">({match.id})</span>
                </li>
              ))}
            </ul>
            <p className="mt-0.5 text-ink-3">A wrong match? Learn again without that client.</p>
          </div>
        )}
        {look.profile && (
          <div className="flex flex-col gap-1.5 rounded-lg bg-selected p-2 text-[12.5px]">
            <p>
              From {look.profile.from} clients: industry codes {look.profile.sicCodes.join(", ")}
              {look.profile.ageMin !== null &&
                `, ${look.profile.ageMin}–${look.profile.ageMax ?? "any"} years old`}
            </p>
            <label className="flex items-center gap-2">
              <span className="text-ink-3">Area</span>
              <input
                value={area ?? look.profile.area ?? ""}
                onChange={(e) => setArea(e.target.value)}
                className={cn(field, "h-7 min-w-0 flex-1")}
              />
            </label>
            <div className="flex items-center gap-2">
              <span className="flex-1 text-ink-3">
                {look.approved ? "Scans use it." : "Not used until you approve it."}
              </span>
              <Button
                size="sm"
                variant={look.approved ? "ghost" : "primary"}
                onClick={() =>
                  updateLook.mutate(
                    {
                      body: {
                        profile: area !== null ? { area: area.trim() || null } : {},
                        approved: !look.approved,
                      },
                    },
                    { onSuccess: () => setArea(null) },
                  )
                }
              >
                {look.approved ? "Stop using it" : "Approve"}
              </Button>
            </div>
          </div>
        )}
      </section>

      <label className="flex items-center gap-2 text-[12.5px]">
        <input
          type="checkbox"
          checked={!project.watchOff}
          onChange={(e) => watchList.mutate({ body: { off: !e.target.checked } })}
        />
        Watch quiet fits: each scan you start re-checks up to 20 of them for new signs.
      </label>
    </div>
  );
}
