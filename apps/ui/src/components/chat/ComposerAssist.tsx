import { CornerUpLeft, X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { messageText, type Bot, type Message, type Skill } from "@mrog/shared";
import { BotAvatar, cn } from "@mrog/ui-kit";

type Suggestion = { key: string; label: string; detail?: string; bot?: Bot; apply(text: string): string };

/** What the user is typing at the end of the input: an @mention or a /skill. */
function suggestionsFor(text: string, members: Bot[], skills: Skill[]): Suggestion[] {
  const mention = /(^|\s)@([\w][\w ]{0,30})?$/.exec(text);
  if (mention && members.length > 0) {
    const partial = (mention[2] ?? "").toLowerCase();
    const options: Suggestion[] = members
      .filter((bot) => bot.name.toLowerCase().startsWith(partial))
      .map((bot) => ({
        key: bot.id,
        label: bot.name,
        detail: bot.label ?? undefined,
        bot,
        apply: (current) => current.replace(/@([\w][\w ]{0,30})?$/, `@${bot.name} `),
      }));
    if ("everyone".startsWith(partial)) {
      options.push({
        key: "everyone",
        label: "everyone",
        detail: "every bot in this chat",
        apply: (current) => current.replace(/@([\w][\w ]{0,30})?$/, "@everyone "),
      });
    }
    return options.slice(0, 7);
  }
  const skill = /^\/([\w-]*)$/.exec(text);
  if (skill) {
    return skills
      .filter((candidate) => candidate.name.startsWith(skill[1] ?? ""))
      .slice(0, 7)
      .map((candidate) => ({
        key: candidate.id,
        label: `/${candidate.name}`,
        detail: candidate.prompt,
        apply: () => candidate.prompt,
      }));
  }
  return [];
}

/** Mention and skill suggestions, plus the "replying to" chip, for the composer. */
export function useComposerAssist(options: {
  members: Bot[];
  skills: Skill[];
  replyTo: Message | null;
  bots: Map<string, Bot>;
  onCancelReply(): void;
}) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const suggestions = dismissed === text ? [] : suggestionsFor(text, options.members, options.skills);
  const index = Math.min(active, Math.max(0, suggestions.length - 1));

  const choose = (suggestion: Suggestion) => {
    setText(suggestion.apply(text));
    setActive(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      choose(suggestions[index]!);
      return true;
    }
    if (event.key === "Escape") {
      setDismissed(text);
      return true;
    }
    return false;
  };

  const replyBot = options.replyTo?.botId ? options.bots.get(options.replyTo.botId) : undefined;
  const above = (
    <>
      {suggestions.length > 0 && (
        <ul
          className="mb-1.5 overflow-hidden rounded-xl border border-border bg-surface shadow-pop"
          role="listbox"
          aria-label="Suggestions"
        >
          {suggestions.map((suggestion, i) => (
            <li key={suggestion.key}>
              <button
                type="button"
                role="option"
                aria-selected={i === index}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(suggestion);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]",
                  i === index ? "bg-selected" : "hover:bg-hover",
                )}
              >
                {suggestion.bot && <BotAvatar avatar={suggestion.bot.avatar} size={18} />}
                <span className="font-medium">{suggestion.label}</span>
                {suggestion.detail && (
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-3">{suggestion.detail}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {options.replyTo && (
        <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-hover px-3 py-1.5 text-[12.5px] text-ink-2">
          <CornerUpLeft size={13} />
          <span className="shrink-0 font-medium">Replying to {replyBot?.name ?? "you"}</span>
          <span className="min-w-0 flex-1 truncate text-ink-3">{messageText(options.replyTo)}</span>
          <button
            type="button"
            aria-label="Cancel reply"
            onClick={options.onCancelReply}
            className="rounded p-0.5 hover:bg-selected"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </>
  );

  return { text, setText, onKeyDown, above };
}
