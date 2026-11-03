import { Globe, MessageCircle, MessagesSquare, Monitor, PanelRight, Square } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import type { Bot, Message, Thread } from "@mrog/shared";
import { BotAvatar, Button, cn, IconButton } from "@mrog/ui-kit";

import { useBots } from "../../hooks/bots";
import { useDiscussion, useStopDiscussion } from "../../hooks/discussion";
import { useRuntime } from "../../hooks/runtime";
import { useSkills } from "../../hooks/team";
import { useMessageHistory, useSendMessage, useStopThread } from "../../hooks/threads";
import { isMac } from "../../lib/harness";
import { layerOpen } from "../../lib/layers";
import { quoteInto } from "../../lib/quote";
import { useUi } from "../../state";
import { BrowserPanel } from "../browser/BrowserPanel";
import { ComputerPanel } from "../computer/ComputerPanel";
import { DetailsPanel } from "../details/DetailsPanel";
import { groupTitle } from "../Sidebar";
import { VoiceButton } from "../voice/VoiceButton";
import { Composer, COMPOSER_ID } from "./Composer";
import { DiscussDialog } from "./DiscussDialog";
import { useComposerAssist } from "./ComposerAssist";
import { MessageList } from "./MessageList";
import { ModelMenu } from "./ModelMenu";

// Only group chats show these, so they load the first time one opens.
const DiscussionView = lazy(() =>
  import("../discussion/DiscussionView").then((module) => ({ default: module.DiscussionView })),
);
const RaceView = lazy(() => import("../race/RaceView").then((module) => ({ default: module.RaceView })));

const ACTIVITY_TEXT = {
  queued: "Waiting for the model…",
  thinking: "Thinking…",
  working: "Working…",
  waiting_user: "Waiting for you",
} as const;

export function ChatView({ thread }: { thread: Thread }) {
  const { data: bots } = useBots();
  const { messages, hasOlder, loadingOlder, loadOlder } = useMessageHistory(thread.id);
  const { data: runtime } = useRuntime();
  const send = useSendMessage(thread.id);
  const stop = useStopThread(thread.id);
  const activity = useUi((state) => state.activity[thread.id]);
  const panel = useUi((state) => state.panel);
  const setPanel = useUi((state) => state.setPanel);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [discussOpen, setDiscussOpen] = useState(false);
  const { data: discussion } = useDiscussion(thread.id, thread.kind === "group");
  const stopDiscussion = useStopDiscussion(thread.id);
  const discussing = discussion?.status === "running" || discussion?.status === "summarizing";
  // Clusters exist for their discussion, so they open on the round table.
  const [view, setView] = useState<"chat" | "table">(thread.cluster ? "table" : "chat");
  // Switch to the round table when a discussion starts (or is already running when the chat opens).
  const lastStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (discussion?.status === "running" && lastStatus.current !== "running") setView("table");
    lastStatus.current = discussion?.status;
  }, [discussion?.status]);

  const botMap = useMemo(() => new Map((bots ?? []).map((bot) => [bot.id, bot])), [bots]);
  const members = thread.memberIds.flatMap((id) => botMap.get(id) ?? []);
  const bot: Bot | undefined = thread.kind === "direct" ? members[0] : undefined;
  const { data: skills } = useSkills(bot?.id);
  const title = bot?.name ?? groupTitle(thread, botMap);
  const noModel = !runtime?.settings.sharedModel && !bot?.model;
  const activeBot = activity?.botId ? botMap.get(activity.botId) : undefined;
  const assist = useComposerAssist({
    members: thread.kind === "group" ? members : [],
    skills: skills ?? [],
    replyTo,
    bots: botMap,
    onCancelReply: () => setReplyTo(null),
  });
  const detailsKey = isMac() ? "⌘⇧I" : "Ctrl+Alt+B";
  const setText = assist.setText;
  const composing = !thread.race && (view === "chat" || thread.kind !== "group");

  // Cmd/Ctrl+L: the text selected in the chat goes into the message box as a quote.
  useEffect(() => {
    if (!composing) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "l" || layerOpen()) return;
      const selected = window.getSelection()?.toString() ?? "";
      if (!selected.trim()) return;
      event.preventDefault();
      setText((current) => quoteInto(current, selected));
      document.getElementById(COMPOSER_ID)?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composing, setText]);

  return (
    <div className="flex h-full min-h-0">
      <main className="flex min-w-0 flex-1 flex-col bg-bg">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
          <button
            type="button"
            onClick={() => setPanel("details")}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 text-left"
            title={`Details (${detailsKey})`}
          >
            {bot ? (
              <BotAvatar avatar={bot.avatar} size={28} />
            ) : (
              <span className="flex -space-x-2">
                {members.slice(0, 3).map((member) => (
                  <BotAvatar
                    key={member.id}
                    avatar={member.avatar}
                    size={24}
                    className="rounded-full ring-2 ring-bg"
                  />
                ))}
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate text-[15px] leading-tight font-semibold">{title}</span>
              <span className="block truncate text-xs text-ink-3">
                {bot ? (bot.label ?? "Add a label") : members.map((member) => member.name).join(", ")}
              </span>
            </span>
          </button>
          {bot && <ModelMenu bot={bot} />}
          {bot && (
            <IconButton
              label="Browser"
              onClick={() => setPanel("browser")}
              className={panel === "browser" ? "bg-selected" : ""}
            >
              <Globe size={16} />
            </IconButton>
          )}
          {bot && (
            <IconButton
              label="Computer"
              onClick={() => setPanel("computer")}
              className={panel === "computer" ? "bg-selected" : ""}
            >
              <Monitor size={16} />
            </IconButton>
          )}
          {thread.kind === "group" && !thread.race && (
            <div className="flex rounded-lg border border-border p-0.5 text-[12.5px]" role="tablist">
              {(
                [
                  ["chat", "Chat", MessageCircle],
                  ["table", "Round table", MessagesSquare],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={view === value}
                  onClick={() => setView(value)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1",
                    view === value ? "bg-selected font-medium text-ink" : "text-ink-3 hover:text-ink",
                  )}
                >
                  <Icon size={13} /> {label}
                  {value === "table" && discussing && (
                    <span className="size-1.5 animate-pulse rounded-full bg-success" />
                  )}
                </button>
              ))}
            </div>
          )}
          <IconButton
            label={`Details (${detailsKey})`}
            onClick={() => setPanel("details")}
            className={panel === "details" ? "bg-selected" : ""}
          >
            <PanelRight size={16} />
          </IconButton>
        </header>

        {thread.race ? (
          <Suspense fallback={<div className="mrog-stage flex-1" />}>
            <RaceView thread={thread} bots={botMap} />
          </Suspense>
        ) : view === "table" && thread.kind === "group" ? (
          <Suspense fallback={<div className="mrog-stage flex-1" />}>
            <DiscussionView
              thread={thread}
              members={members}
              bots={botMap}
              messages={messages ?? []}
              discussion={discussion}
              noModel={noModel}
              onNew={() => setDiscussOpen(true)}
            />
          </Suspense>
        ) : (
          <>
            {messages && messages.length > 0 ? (
              <MessageList
                messages={messages}
                bots={botMap}
                onReply={setReplyTo}
                hasOlder={hasOlder}
                loadingOlder={loadingOlder}
                onLoadOlder={loadOlder}
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                {bot && <BotAvatar avatar={bot.avatar} size={72} />}
                <p className="text-base font-medium">{title}</p>
                <p className="max-w-sm text-[13px] text-ink-3">
                  {bot
                    ? "Give it a job: what it should do, where to look, and when to check with you. Ask it to remember."
                    : "Write to the group. Mention a bot with @ to ask just that one, or @everyone."}
                </p>
              </div>
            )}

            {discussion && discussing && (
              <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-5 pt-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-selected px-3 py-1.5 text-[12.5px]">
                  <MessagesSquare size={13} className="shrink-0 text-accent" />
                  <span className="truncate">
                    <span className="font-medium">{discussion.topic}</span>
                    <span className="text-ink-3">
                      {" · "}
                      {discussion.status === "summarizing"
                        ? "Writing the summary…"
                        : discussion.round === 0
                          ? "Choosing roles…"
                          : `Round ${discussion.round} of ${discussion.rounds}${
                              discussion.speakerId && botMap.get(discussion.speakerId)
                                ? ` · ${botMap.get(discussion.speakerId)!.name} is speaking`
                                : ""
                            }`}
                    </span>
                  </span>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setView("table")}>
                  <MessagesSquare size={12} /> Open round table
                </Button>
                <Button size="sm" variant="ghost" onClick={() => stopDiscussion.mutate()}>
                  <Square size={12} /> Stop discussion
                </Button>
              </div>
            )}
            {discussion?.status === "error" && discussion.error && (
              <p className="mx-auto w-full max-w-3xl px-5 pt-2 text-xs text-danger">
                The discussion stopped: {discussion.error}
              </p>
            )}

            <div className="mx-auto h-6 w-full max-w-3xl px-5 text-xs text-ink-3" aria-live="polite">
              {activity && (
                <span>
                  {activeBot && thread.kind === "group" ? `${activeBot.name}: ` : ""}
                  {ACTIVITY_TEXT[activity.activity as keyof typeof ACTIVITY_TEXT] ?? ""}
                </span>
              )}
            </div>

            <Composer
              placeholder={
                noModel
                  ? "Pick a model in Settings to start"
                  : discussing
                    ? "Add to the discussion: the next speaker answers you"
                    : `Message ${title}`
              }
              disabled={noModel}
              busy={Boolean(activity)}
              text={assist.text}
              onText={assist.setText}
              onKeyDown={assist.onKeyDown}
              above={assist.above}
              tools={
                <VoiceButton
                  onTranscript={(text) => setText((current) => (current ? `${current} ${text}` : text))}
                />
              }
              onSend={async (input) => {
                await send.mutateAsync({ ...input, ...(replyTo ? { replyToId: replyTo.id } : {}) });
                setReplyTo(null);
              }}
              onStop={() => stop.mutate()}
            />
          </>
        )}
      </main>
      {panel === "details" && <DetailsPanel thread={thread} />}
      {discussOpen && (
        <DiscussDialog threadId={thread.id} members={members} onClose={() => setDiscussOpen(false)} />
      )}
      {panel === "computer" && bot && <ComputerPanel bot={bot} />}
      {panel === "browser" && bot && <BrowserPanel bot={bot} />}
    </div>
  );
}
