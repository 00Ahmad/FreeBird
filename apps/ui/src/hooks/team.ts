import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  Bot,
  CreateGroupInput,
  MemoryNote,
  Skill,
  SkillInput,
  Thread,
  UpdateGroupInput,
} from "@mrog/shared";

import { api } from "../lib/api";
import { upsertBot } from "./bots";
import { upsertThread } from "./threads";

export function useCreateGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateGroupInput) =>
      (await api<{ thread: Thread }>("/threads", { method: "POST", body: input })).thread,
    onSuccess: (thread) => upsertThread(client, thread),
  });
}

export function useUpdateGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateGroupInput }) =>
      (await api<{ thread: Thread }>(`/threads/${id}`, { method: "PATCH", body: patch })).thread,
    onSuccess: (thread) => upsertThread(client, thread),
  });
}

export function useDeleteGroup() {
  return useMutation({ mutationFn: (id: string) => api<void>(`/threads/${id}`, { method: "DELETE" }) });
}

const memoryKey = (botId: string) => ["memory", botId] as const;

export function useMemory(botId: string) {
  return useQuery({
    queryKey: memoryKey(botId),
    // `notSent`: the oldest notes that no longer fit the prompt, so the bot doesn't see them; `sentIds` are the ones it
    // sees; `pinnedOver`: the pinned notes alone are more than the room for memory.
    queryFn: async () =>
      await api<{ notes: MemoryNote[]; notSent?: number; sentIds?: string[]; pinnedOver?: boolean }>(
        `/bots/${botId}/memory`,
      ),
  });
}

function useInvalidate(key: readonly unknown[]) {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: key });
}

export function useMemoryActions(botId: string) {
  const invalidate = useInvalidate(["memory"]);
  return {
    add: useMutation({
      mutationFn: (text: string) => api(`/bots/${botId}/memory`, { method: "POST", body: { text } }),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, text }: { id: string; text: string }) =>
        api(`/memory/${id}`, { method: "PATCH", body: { text } }),
      onSuccess: invalidate,
    }),
    /** Pinned notes are always sent to the model, and the bot can't forget them. */
    pin: useMutation({
      mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
        api(`/memory/${id}`, { method: "PATCH", body: { pinned } }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/memory/${id}`, { method: "DELETE" }),
      onSuccess: invalidate,
    }),
    importText: useMutation({
      mutationFn: (text: string) =>
        api<{ added: number }>(`/bots/${botId}/memory/import`, { method: "POST", body: { text } }),
      onSuccess: invalidate,
    }),
  };
}

export function useSkills(botId?: string) {
  return useQuery({
    queryKey: ["skills", botId ?? "all"],
    queryFn: async () => (await api<{ skills: Skill[] }>(`/skills${botId ? `?botId=${botId}` : ""}`)).skills,
  });
}

export function useSkillActions() {
  const invalidate = useInvalidate(["skills"]);
  return {
    add: useMutation({
      mutationFn: (input: SkillInput) => api("/skills", { method: "POST", body: input }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/skills/${id}`, { method: "DELETE" }),
      onSuccess: invalidate,
    }),
  };
}

export function useReact() {
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      api(`/messages/${messageId}/reactions`, { method: "POST", body: { emoji } }),
  });
}

export function useDuplicateBot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api<{ bot: Bot }>(`/bots/${id}/duplicate`, { method: "POST" })).bot,
    onSuccess: (bot) => upsertBot(client, bot),
  });
}

export function useBotFiles(botId: string) {
  return useQuery({
    queryKey: ["files", botId],
    queryFn: () =>
      api<{ root: string; files: { path: string; size: number; modifiedAt: string }[] }>(
        `/bots/${botId}/files`,
      ),
    staleTime: 5_000,
  });
}

/** A bot packaged for someone else: profile, instructions, model and its own skills. No history or memory. */
export interface BotTemplate {
  kind: "freebird.bot";
  version: 1;
  bot: Pick<Bot, "name" | "label" | "avatar" | "instructions" | "model">;
  skills: { name: string; prompt: string }[];
}
