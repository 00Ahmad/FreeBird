import { AlertTriangle, Clock, RotateCcw, Settings2, Shuffle } from "lucide-react";
import { useEffect, useState } from "react";

import { repeatsAction, type Bot, type Message, type MessagePart } from "@mrog/shared";
import { Button } from "@mrog/ui-kit";

import { useModelIsLocal } from "../../hooks/providers";
import { useRetryReply, useThread } from "../../hooks/threads";
import { plainError, type ErrorAction } from "../../lib/plain-error";
import { nextStageIn, slowStage } from "../../lib/slow-reply";
import { useUi } from "../../state";

/** What the buttons under a reply in trouble can do: try it again, or pick another model (and then try it again). */
function useReplyActions(message: Message, bot: Bot | undefined, retryable: boolean) {
  const retry = useRetryReply();
  const openSettings = useUi((state) => state.openSettings);
  const askModelSwitch = useUi((state) => state.askModelSwitch);
  const thread = useThread(message.threadId);
  // The model menu lives in a one-to-one chat's header; a group has no single model to switch.
  const canSwitchModel = thread?.kind === "direct" && Boolean(bot);

  const run = (action: ErrorAction) => {
    if (!bot) return;
    if (action === "retry")
      retry.mutate({ threadId: message.threadId, botId: bot.id, messageId: message.id });
    else if (action === "switch-model")
      askModelSwitch({
        botId: bot.id,
        threadId: message.threadId,
        retryMessageId: retryable ? message.id : null,
      });
    else openSettings(action === "settings-providers" ? "providers" : "model");
  };
  return { run, canSwitchModel, retry };
}

const LABEL: Record<ErrorAction, string> = {
  retry: "Try again",
  "switch-model": "Switch model",
  "settings-model": "Open settings",
  "settings-providers": "Open settings",
};

function ActionIcon({ action }: { action: ErrorAction }) {
  if (action === "retry") return <RotateCcw size={13} />;
  if (action === "switch-model") return <Shuffle size={13} />;
  return <Settings2 size={13} />;
}

/**
 * An error in a reply, in plain words, with what can be done about it. "Try again" is offered only on the bot's latest
 * reply and only when answering again can't repeat something it already did (the server checks too).
 */
export function ErrorNotice({
  part,
  message,
  bot,
  latest,
}: {
  part: Extract<MessagePart, { type: "error" }>;
  message: Message;
  bot: Bot | undefined;
  latest: boolean;
}) {
  const retryable = latest && Boolean(bot) && message.status !== "streaming" && !repeatsAction(message);
  const { run, canSwitchModel, retry } = useReplyActions(message, bot, retryable);
  const plain = plainError({ code: part.code, message: part.message, retryable });
  const actions = plain.actions.filter((action) => action !== "switch-model" || (canSwitchModel && latest));

  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2.5 text-[13px]">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-ink select-text">{plain.title}</p>
        {plain.hint && <p className="mt-0.5 text-ink-2 select-text">{plain.hint}</p>}
        {actions.length > 0 && (
          <div className="mt-1.5 -ml-2 flex flex-wrap gap-1">
            {actions.map((action) => (
              <Button
                key={action}
                size="sm"
                variant="ghost"
                disabled={action === "retry" && retry.isPending}
                onClick={() => run(action)}
              >
                <ActionIcon action={action} /> {LABEL[action]}
              </Button>
            ))}
          </div>
        )}
        {retry.isError && <p className="mt-1 text-xs text-danger select-text">{retry.error.message}</p>}
        {plain.detail && (
          <details className="mt-1.5 text-xs text-ink-3">
            <summary className="w-fit cursor-pointer select-none hover:text-ink-2">Details</summary>
            <p className="mt-1 break-words whitespace-pre-wrap select-text">{plain.detail}</p>
          </details>
        )}
      </div>
    </div>
  );
}

/** Replies the user said "Keep waiting" to: not asked about again. Per viewer, not saved. */
const keptWaiting = new Set<string>();

/**
 * Under a reply that has not said a word yet. Says nothing for the first 20 seconds. After that, a local model is
 * "loading" (they take a minute to read a long chat), and Try again / Switch model appear after a minute and a half
 * there, and after 20 seconds for a cloud model. Nothing is offered while the reply waits behind other work, since
 * starting over would not get it a turn sooner. The clock is the reply's own, so switching chats doesn't reset it.
 */
export function SlowReply({ message, bot }: { message: Message; bot: Bot | undefined }) {
  const local = useModelIsLocal(message.model);
  const queued = useUi((state) => {
    const activity = state.activity[message.threadId];
    return activity?.activity === "queued" && activity.botId === message.botId;
  });
  const [dismissed, setDismissed] = useState(() => keptWaiting.has(message.id));
  const [now, setNow] = useState(() => Date.now());
  const elapsedMs = Math.max(0, now - Date.parse(message.createdAt));
  const input = { elapsedMs, local, queued, dismissed };
  const stage = slowStage(input);
  const { run, canSwitchModel, retry } = useReplyActions(message, bot, true);

  // One timer, set for the next moment the stage can change; when it fires, the clock moves on and this runs again.
  useEffect(() => {
    const wait = nextStageIn({
      elapsedMs: Math.max(0, now - Date.parse(message.createdAt)),
      local,
      queued,
      dismissed,
    });
    if (wait === null) return;
    const timer = setTimeout(() => setNow(Date.now()), wait + 50);
    return () => clearTimeout(timer);
  }, [now, local, queued, dismissed, message.createdAt]);

  if (stage === "none") return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-2" role="status">
      <Clock size={14} className="shrink-0 text-ink-3" />
      <span>
        {local && stage === "note"
          ? "Still loading the model. A model on this computer can take a minute."
          : "This is taking longer than usual."}
      </span>
      {stage === "actions" && (
        <span className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" disabled={retry.isPending} onClick={() => run("retry")}>
            <RotateCcw size={13} /> Try again
          </Button>
          {canSwitchModel && (
            <Button size="sm" variant="ghost" onClick={() => run("switch-model")}>
              <Shuffle size={13} /> Switch model
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              keptWaiting.add(message.id);
              setDismissed(true);
            }}
          >
            Keep waiting
          </Button>
        </span>
      )}
      {retry.isError && <span className="text-xs text-danger">{retry.error.message}</span>}
    </div>
  );
}
