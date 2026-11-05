import { X } from "lucide-react";
import { useState } from "react";

import { MAX_GROUP_MEMBERS } from "@mrog/shared";
import { BotAvatar, Button, cn } from "@mrog/ui-kit";

import { useBots } from "../hooks/bots";
import { useCreateGroup } from "../hooks/team";
import { useUi } from "../state";
import { Modal } from "./Modal";

/** New group chat: pick 2–6 bots in the "To:" field. */
export function NewGroupDialog() {
  const { data: bots } = useBots();
  const create = useCreateGroup();
  const setOverlay = useUi((state) => state.setOverlay);
  const select = useUi((state) => state.select);
  const [members, setMembers] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [title, setTitle] = useState("");
  const close = () => setOverlay(null);

  const toggle = (id: string) =>
    setMembers((current) =>
      current.includes(id)
        ? current.filter((existing) => existing !== id)
        : current.length >= MAX_GROUP_MEMBERS
          ? current
          : [...current, id],
    );
  const options = (bots ?? []).filter(
    (bot) => !bot.hidden && !bot.clusterId && bot.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <Modal title="New group chat" onClose={close}>
      <div className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border px-2.5 py-2 focus-within:border-accent">
          <span className="text-[13px] text-ink-3">To:</span>
          {members.map((id) => {
            const bot = bots?.find((candidate) => candidate.id === id);
            return (
              <span
                key={id}
                className="flex items-center gap-1 rounded-full bg-selected py-0.5 pr-1 pl-1.5 text-[12.5px]"
              >
                {bot && <BotAvatar avatar={bot.avatar} size={16} />}
                {bot?.name}
                <button
                  type="button"
                  aria-label={`Remove ${bot?.name}`}
                  onClick={() => toggle(id)}
                  className="rounded-full p-0.5 hover:bg-hover"
                >
                  <X size={11} />
                </button>
              </span>
            );
          })}
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && options[0]) {
                event.preventDefault();
                toggle(options[0].id);
                setFilter("");
              }
              if (event.key === "Backspace" && !filter && members.length) toggle(members.at(-1)!);
            }}
            placeholder={members.length ? "" : "Add bots"}
            aria-label="Add bots"
            className="min-w-24 flex-1 bg-transparent text-[13px] outline-none"
          />
        </div>
        <ul
          className="max-h-56 overflow-y-auto rounded-xl border border-border"
          role="listbox"
          aria-multiselectable="true"
        >
          {options.map((bot) => (
            <li key={bot.id}>
              <button
                type="button"
                role="option"
                aria-selected={members.includes(bot.id)}
                onClick={() => toggle(bot.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 border-b border-border px-3 py-2 text-left text-[13px] last:border-b-0 hover:bg-hover",
                  members.includes(bot.id) && "bg-selected",
                )}
              >
                <BotAvatar avatar={bot.avatar} size={22} />
                <span className="flex-1 truncate font-medium">{bot.name}</span>
                {bot.label && <span className="truncate text-xs text-ink-3">{bot.label}</span>}
              </button>
            </li>
          ))}
          {options.length === 0 && <li className="px-3 py-2 text-[13px] text-ink-3">No bots match.</li>}
        </ul>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Group name (optional)"
          aria-label="Group name"
          className="h-9 rounded-lg border border-border bg-bg px-3 text-[13px] outline-none focus:border-accent"
        />
        {create.error && <p className="text-xs text-danger">{create.error.message}</p>}
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-3">
            {members.length} of 2–{MAX_GROUP_MEMBERS} bots
          </span>
          <Button
            variant="primary"
            disabled={members.length < 2 || create.isPending}
            onClick={() =>
              create.mutate(
                { memberIds: members, title: title.trim() || null },
                {
                  onSuccess: (thread) => {
                    select(thread.id);
                    close();
                  },
                },
              )
            }
          >
            Start group chat
          </Button>
        </div>
      </div>
    </Modal>
  );
}
