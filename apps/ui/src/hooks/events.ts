import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { messageText, type Bot, type Message, type RuntimeStatus, type ThreadActivity } from "@mrog/shared";

import { api } from "../lib/api";
import { harnessInfo } from "../lib/harness";
import { coalesceDeltas, type Delta } from "../lib/messages";
import { connectEvents } from "../lib/sse";
import { useConnection, useUi } from "../state";
import { isWatching, useUnread } from "../unread";
import { BOTS_KEY, removeBot, upsertBot } from "./bots";
import { setCodingProject } from "./coding";
import { noticeCoding } from "./codingNotice";
import { setDiscussion } from "./discussion";
import { setRace } from "./race";
import { MODELS_KEY, RUNTIME_KEY } from "./runtime";
import { applyDelta, messagesKey, removeThread, upsertMessage, upsertThread } from "./threads";

const notified = new Set<string>();

/** A desktop notification when a bot finishes replying while you're in another chat or app (per-bot toggle). */
function notifyIfAway(client: QueryClient, message: Message) {
  if (message.role !== "bot" || message.status !== "done" || !message.botId || notified.has(message.id))
    return;
  notified.add(message.id);
  const bot = client.getQueryData<Bot[]>(BOTS_KEY)?.find((candidate) => candidate.id === message.botId);
  // A Coding Bot posts a message for every step; it tells you when it needs you instead (see noticeCoding).
  if (bot?.coding) return;
  const watching = document.hasFocus() && useUi.getState().selectedThreadId === message.threadId;
  if (!bot?.notifications || watching || typeof Notification === "undefined") return;
  const text = messageText(message).replace(/\s+/g, " ").trim();
  if (!text) return;
  const notification = new Notification(bot.name, { body: text.slice(0, 160), silent: false });
  notification.addEventListener("click", () => {
    window.focus();
    useUi.getState().select(message.threadId);
  });
}

/** Chats where a bot is waiting for you and you've been told: told once per wait. */
const waitingNoticed = new Set<string>();

/**
 * A desktop notification when a bot starts waiting for you (a check to solve, a question, an approval) while you're
 * in another chat or app, so you needn't keep watching it work. Same per-bot switch as replies.
 */
function notifyWaiting(
  client: QueryClient,
  threadId: string,
  botId: string | null,
  activity: ThreadActivity,
) {
  const key = `${threadId}:${botId ?? ""}`;
  if (activity !== "waiting_user") {
    waitingNoticed.delete(key);
    return;
  }
  if (waitingNoticed.has(key)) return;
  waitingNoticed.add(key);
  const bot = client.getQueryData<Bot[]>(BOTS_KEY)?.find((candidate) => candidate.id === botId);
  const watching = document.hasFocus() && useUi.getState().selectedThreadId === threadId;
  if (!bot?.notifications || watching || typeof Notification === "undefined") return;
  const notification = new Notification(bot.name, {
    body: `${bot.name} needs you for a moment.`,
    silent: false,
  });
  notification.addEventListener("click", () => {
    window.focus();
    useUi.getState().select(threadId);
  });
}

/** Opens the harness event stream for the app's lifetime and folds events into cached state. */
export function useHarnessEvents() {
  const client = useQueryClient();

  useEffect(() => {
    const harness = harnessInfo();
    if (!harness) {
      useConnection.getState().setStatus("offline");
      return;
    }
    const connection = useConnection.getState();
    const ui = useUi.getState();

    const refreshActivity = () =>
      void api<{ activity: Record<string, { botId: string | null; activity: ThreadActivity }> }>("/activity")
        .then((res) => ui.replaceActivity(res.activity))
        .catch(() => {});

    // Streamed chunks are applied once per frame rather than once per token.
    let deltas: Delta[] = [];
    let frame = 0;
    const flushDeltas = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      const batch = coalesceDeltas(deltas);
      deltas = [];
      for (const delta of batch) applyDelta(client, delta);
    };
    let connected = false;

    const disconnect = connectEvents({
      url: harness.url,
      token: harness.token,
      onStatus: connection.setStatus,
      onEvent: (event, resumed) => {
        if (event.type === "message.delta") {
          deltas.push(event);
          if (!frame) frame = requestAnimationFrame(flushDeltas);
          return;
        }
        // Anything else (a full message.updated, say) lands after the chunks that came before it.
        if (deltas.length) flushDeltas();
        switch (event.type) {
          case "stream.hello":
            connection.hello(event.version);
            // Download progress isn't replayed, so drop it; downloads still running report again within a moment.
            ui.dropPull();
            refreshActivity();
            if (!connected) {
              connected = true;
              // The first queries are already loading; refetch only those that finished before the stream opened.
              void client.invalidateQueries(undefined, { cancelRefetch: false });
            } else if (resumed) {
              // Missed events are replayed next (or stream.resync follows). Stream-only state isn't: the runtime
              // status, and chunks of replies that kept streaming while we were away.
              void client.invalidateQueries({ queryKey: RUNTIME_KEY });
              void client.invalidateQueries({ queryKey: ["messages"] });
            } else {
              // Nothing to resume from: refetch rather than trust the cache.
              void client.invalidateQueries();
            }
            break;
          case "stream.resync":
            void client.invalidateQueries();
            refreshActivity();
            break;
          case "heartbeat":
            connection.beat();
            break;
          case "bot.created":
          case "bot.updated":
            upsertBot(client, event.bot);
            break;
          case "bot.deleted":
            removeBot(client, event.botId);
            break;
          case "thread.created":
          case "thread.updated":
            upsertThread(client, event.thread);
            break;
          case "thread.deleted":
            removeThread(client, event.threadId);
            useUnread.getState().forget(event.threadId);
            if (useUi.getState().selectedThreadId === event.threadId) ui.select(null);
            break;
          case "message.created":
            upsertMessage(client, event.message);
            break;
          case "message.updated":
            upsertMessage(client, event.message);
            notifyIfAway(client, event.message);
            useUnread.getState().arrive(event.message, isWatching(event.message.threadId));
            break;
          case "thread.activity":
            ui.setActivity(event.threadId, event.botId, event.activity);
            notifyWaiting(client, event.threadId, event.botId, event.activity);
            break;
          case "runtime.status":
            client.setQueryData<RuntimeStatus>(RUNTIME_KEY, event.status);
            break;
          case "runtime.pull":
            ui.setPull(event.model, event);
            if (event.done) void client.invalidateQueries({ queryKey: MODELS_KEY });
            break;
          case "discussion.updated":
            setDiscussion(client, event.discussion);
            break;
          case "coding.updated":
            // Before the cache is replaced, so the old status is still there to compare with.
            noticeCoding(client, event.project);
            setCodingProject(client, event.project);
            break;
          case "race.updated":
            setRace(client, event.race);
            break;
          case "data.changed":
            for (const key of event.keys) {
              // One thread's messages (its chat was cleared): the live page and any older pages under it.
              if (key === "messages" && event.threadId)
                void client.invalidateQueries({ queryKey: messagesKey(event.threadId) });
              else void client.invalidateQueries({ queryKey: [key] });
            }
            break;
        }
      },
    });
    return () => {
      disconnect();
      cancelAnimationFrame(frame);
    };
  }, [client]);
}
