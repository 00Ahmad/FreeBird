import { skipToken, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import type { Message, SendMessageInput, Thread } from "@mrog/shared";

import { api, ApiRequestError } from "../lib/api";
import { HeldEvents, keepStreamed, mergeDelta, mergeMessage, replayHeld, type Delta } from "../lib/messages";

export const THREADS_KEY = ["threads"] as const;
export const messagesKey = (threadId: string) => ["messages", threadId] as const;
const olderMessagesKey = (threadId: string) => [...messagesKey(threadId), "older"] as const;

/** Events for a thread whose messages are being fetched for the first time: they have nothing to land on yet. */
const held = new HeldEvents();

/** Messages per request; a shorter answer means the thread has nothing older. */
const PAGE = 200;

/** History loaded with "Show earlier messages", kept apart from the live page that events write into. */
interface OlderMessages {
  messages: Message[];
  /** createdAt of the live page's first message when this history was fetched: where the two join. */
  joinsAt: string;
  more: boolean;
}

export function useThreads() {
  return useQuery({
    queryKey: THREADS_KEY,
    queryFn: async () => (await api<{ threads: Thread[] }>("/threads")).threads,
  });
}

export function useThread(threadId: string | null) {
  const { data } = useThreads();
  return data?.find((thread) => thread.id === threadId) ?? null;
}

export function upsertThread(client: QueryClient, thread: Thread) {
  client.setQueryData<Thread[]>(THREADS_KEY, (old) =>
    old ? [...old.filter((existing) => existing.id !== thread.id), thread] : old,
  );
}

export function removeThread(client: QueryClient, threadId: string) {
  client.setQueryData<Thread[]>(THREADS_KEY, (old) => old?.filter((thread) => thread.id !== threadId));
  client.removeQueries({ queryKey: messagesKey(threadId) });
}

export function useMessages(threadId: string | null) {
  const client = useQueryClient();
  const key = messagesKey(threadId ?? "none");
  return useQuery({
    queryKey: key,
    enabled: Boolean(threadId),
    queryFn: async () => {
      const id = threadId!;
      held.begin(id);
      let page: Message[];
      try {
        page = (await api<{ messages: Message[] }>(`/threads/${id}/messages?limit=${PAGE}`)).messages;
      } catch (error) {
        held.end(id);
        throw error;
      }
      // Compared with the cache as it is now, after the chunks that streamed in during the request, and then with
      // what arrived for a thread that had nothing cached yet.
      return replayHeld(keepStreamed(client.getQueryData<Message[]>(key), page), held.end(id));
    },
  });
}

/** The live page plus any older pages the user asked for, oldest first. */
export function useMessageHistory(threadId: string) {
  const client = useQueryClient();
  const { data: latest } = useMessages(threadId);
  // Filled only by `loadOlder`, so invalidations never refetch (and reset) it.
  const { data: older } = useQuery<OlderMessages>({
    queryKey: olderMessagesKey(threadId),
    queryFn: skipToken,
  });
  // After a reconnect or a cleared chat the live page may no longer start where the older pages end: drop them.
  const joined = older && latest?.[0]?.createdAt === older.joinsAt ? older : undefined;
  const messages = useMemo(
    () => (latest && joined ? [...joined.messages, ...latest] : latest),
    [latest, joined],
  );
  const loadOlder = useMutation({
    mutationFn: async () => {
      const base = joined ?? (latest?.[0] && { messages: [], joinsAt: latest[0].createdAt, more: true });
      if (!base) return;
      const before = base.messages[0]?.createdAt ?? base.joinsAt;
      const page = (
        await api<{ messages: Message[] }>(
          `/threads/${threadId}/messages?limit=${PAGE}&before=${encodeURIComponent(before)}`,
        )
      ).messages;
      client.setQueryData<OlderMessages>(olderMessagesKey(threadId), {
        ...base,
        messages: [...page, ...base.messages],
        more: page.length === PAGE,
      });
    },
  });
  return {
    messages,
    hasOlder: joined ? joined.more : (latest?.length ?? 0) >= PAGE,
    loadingOlder: loadOlder.isPending,
    loadOlder: () => loadOlder.mutate(),
  };
}

export function upsertMessage(client: QueryClient, message: Message) {
  // A message on a loaded older page (a new reaction, say) is updated where it is.
  const older = client.getQueryData<OlderMessages>(olderMessagesKey(message.threadId));
  if (older?.messages.some((existing) => existing.id === message.id)) {
    client.setQueryData<OlderMessages>(olderMessagesKey(message.threadId), {
      ...older,
      messages: older.messages.map((existing) => (existing.id === message.id ? message : existing)),
    });
    return;
  }
  const key = messagesKey(message.threadId);
  if (!client.getQueryData<Message[]>(key)) {
    held.hold(message.threadId, { message });
    return;
  }
  client.setQueryData<Message[]>(key, (old) => old && mergeMessage(old, message));
}

/**
 * Appends a streamed chunk to a cached message, creating the part if it's new. A chunk the cached copy can't take
 * yet (it lacks the parts before it) is dropped and the thread refetched, rather than leaving a hole in the parts.
 */
export function applyDelta(client: QueryClient, delta: Delta) {
  const key = messagesKey(delta.threadId);
  const old = client.getQueryData<Message[]>(key);
  if (!old) {
    held.hold(delta.threadId, { delta });
    return;
  }
  const { messages, behind } = mergeDelta(old, delta);
  if (messages !== old) client.setQueryData<Message[]>(key, messages);
  // Don't restart a fetch that is already under way: every chunk of a busy reply lands here.
  if (behind) void client.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
}

export function useSendMessage(threadId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: SendMessageInput) =>
      (await api<{ message: Message }>(`/threads/${threadId}/messages`, { method: "POST", body: input }))
        .message,
    onSuccess: (message) => upsertMessage(client, message),
  });
}

/**
 * "Try again" on a reply that failed or never got going. A 409 "stale" means the reply was already replaced (a second
 * click, another window): nothing is wrong, so it is not reported. Anything else the server refuses is.
 */
export function useRetryReply() {
  return useMutation({ mutationFn: retryReply });
}

/** The request behind "Try again", for callers that outlive the component that started it. */
export async function retryReply(input: {
  threadId: string;
  botId: string;
  messageId: string;
}): Promise<void> {
  try {
    await api(`/threads/${input.threadId}/retry`, {
      method: "POST",
      body: { botId: input.botId, messageId: input.messageId },
    });
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 409 && error.body?.error === "stale") return;
    throw error;
  }
}

export function useStopThread(threadId: string) {
  return useMutation({
    mutationFn: () => api<void>(`/threads/${threadId}/stop`, { method: "POST" }),
  });
}
