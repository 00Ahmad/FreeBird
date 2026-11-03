import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type {
  ClusterMember,
  CreateClusterInput,
  Discussion,
  DiscussionControl,
  DiscussionGoal,
  ProposeClusterInput,
  StartDiscussionInput,
  Thread,
} from "@mrog/shared";

import { api } from "../lib/api";
import { BOTS_KEY } from "./bots";
import { upsertThread } from "./threads";

const discussionKey = (threadId: string) => ["discussion", threadId] as const;

export function setDiscussion(client: QueryClient, discussion: Discussion) {
  client.setQueryData(discussionKey(discussion.threadId), discussion);
}

/** A group chat's current or last discussion; null when it never had one. */
export function useDiscussion(threadId: string, enabled: boolean) {
  return useQuery({
    queryKey: discussionKey(threadId),
    queryFn: async () =>
      (await api<{ discussion: Discussion | null }>(`/threads/${threadId}/discussion`)).discussion,
    enabled,
  });
}

export function useStartDiscussion(threadId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: StartDiscussionInput) =>
      (
        await api<{ discussion: Discussion }>(`/threads/${threadId}/discussion`, {
          method: "POST",
          body: input,
        })
      ).discussion,
    onSuccess: (discussion) => setDiscussion(client, discussion),
  });
}

export function useStopDiscussion(threadId: string) {
  return useMutation({
    mutationFn: () => api<void>(`/threads/${threadId}/discussion/stop`, { method: "POST" }),
  });
}

export function useSuggestRoles(threadId: string) {
  return useMutation({
    mutationFn: async (input: { topic: string; goal: DiscussionGoal }) =>
      (
        await api<{ roles: Record<string, string> }>(`/threads/${threadId}/discussion/roles`, {
          method: "POST",
          body: input,
        })
      ).roles,
  });
}

export function useDiscussionControl(threadId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (action: DiscussionControl["action"]) =>
      (
        await api<{ discussion: Discussion }>(`/threads/${threadId}/discussion/control`, {
          method: "POST",
          body: { action },
        })
      ).discussion,
    onSuccess: (discussion) => setDiscussion(client, discussion),
  });
}

export function useProposeCluster() {
  return useMutation({
    mutationFn: async (input: ProposeClusterInput) =>
      (await api<{ members: ClusterMember[] }>("/clusters/propose", { method: "POST", body: input })).members,
  });
}

export function useCreateCluster() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateClusterInput) =>
      api<{ thread: Thread; discussion: Discussion }>("/clusters", { method: "POST", body: input }),
    onSuccess: ({ thread, discussion }) => {
      upsertThread(client, thread);
      setDiscussion(client, discussion);
      void client.invalidateQueries({ queryKey: BOTS_KEY });
    },
  });
}
