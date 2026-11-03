import { Sparkles } from "lucide-react";
import { useState } from "react";

import { DISCUSSION_GOALS, MAX_DISCUSSION_ROUNDS, type Bot, type DiscussionGoal } from "@mrog/shared";
import { BotAvatar, Button, cn } from "@mrog/ui-kit";

import { useStartDiscussion, useSuggestRoles } from "../../hooks/discussion";
import { Modal } from "../Modal";

const GOALS = Object.entries(DISCUSSION_GOALS) as [DiscussionGoal, { label: string; description: string }][];

/** Start a group discussion: a topic, what it's for, how many rounds, and each bot's role. */
export function DiscussDialog({
  threadId,
  members,
  onClose,
}: {
  threadId: string;
  members: Bot[];
  onClose(): void;
}) {
  const start = useStartDiscussion(threadId);
  const suggest = useSuggestRoles(threadId);
  const [topic, setTopic] = useState("");
  const [goal, setGoal] = useState<DiscussionGoal>("decide");
  const [rounds, setRounds] = useState(3);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const replies = members.length * rounds;
  const error = start.error ?? suggest.error;

  return (
    <Modal title="Start a discussion" onClose={onClose} className="max-w-xl">
      <form
        className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5"
        onSubmit={(event) => {
          event.preventDefault();
          start.mutate({ topic: topic.trim(), goal, rounds, roles }, { onSuccess: onClose });
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Topic</span>
          <textarea
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            rows={3}
            placeholder="What should they discuss? For example: Should a small shop sell on its own website or on a marketplace?"
            className="resize-none rounded-lg border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent"
          />
        </label>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-[13px] font-medium">Goal</legend>
          {GOALS.map(([value, info]) => (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer gap-2.5 rounded-lg border border-border px-3 py-2",
                goal === value && "border-accent bg-selected",
              )}
            >
              <input
                type="radio"
                name="goal"
                checked={goal === value}
                onChange={() => setGoal(value)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-[13px] font-medium">{info.label}</span>
                <span className="block text-xs text-ink-3">{info.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="flex items-center gap-3">
          <span className="text-[13px] font-medium">Rounds</span>
          <select
            value={rounds}
            onChange={(event) => setRounds(Number(event.target.value))}
            className="select w-20"
          >
            {Array.from({ length: MAX_DISCUSSION_ROUNDS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="text-xs text-ink-3">
            {replies} replies and a summary. On a local model that's roughly{" "}
            {Math.max(1, Math.round(replies * 0.4))}–{Math.max(2, Math.round(replies * 0.9))} minutes, longer
            when they research.
          </span>
        </label>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[13px] font-medium">Roles</span>
            <Button
              size="sm"
              type="button"
              disabled={topic.trim().length < 3 || suggest.isPending}
              onClick={() =>
                suggest.mutate(
                  { topic: topic.trim(), goal },
                  { onSuccess: (suggested) => setRoles((current) => ({ ...current, ...suggested })) },
                )
              }
            >
              <Sparkles size={13} /> {suggest.isPending ? "Suggesting…" : "Suggest roles"}
            </Button>
          </div>
          {members.map((bot) => (
            <div key={bot.id} className="flex items-center gap-2.5">
              <BotAvatar avatar={bot.avatar} size={22} />
              <span className="w-24 shrink-0 truncate text-[13px] font-medium">{bot.name}</span>
              <input
                value={roles[bot.id] ?? ""}
                onChange={(event) => setRoles((current) => ({ ...current, [bot.id]: event.target.value }))}
                placeholder="Suggested from the topic when it starts"
                aria-label={`${bot.name}'s role`}
                maxLength={300}
                className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 text-[13px] outline-none focus:border-accent"
              />
            </div>
          ))}
          <p className="text-xs text-ink-3">
            Every bot has to back its claims with a source it opened or with reasoning you can check. They can
            search the web and read pages, nothing else. You can write in the chat at any time; the next
            speaker answers you, and @name makes that bot speak next.
          </p>
        </div>

        {error && <p className="text-xs text-danger">{error.message}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={topic.trim().length < 3 || start.isPending}>
            Start discussion
          </Button>
        </div>
      </form>
    </Modal>
  );
}
