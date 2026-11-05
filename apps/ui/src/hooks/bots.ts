import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { compareBots, type Bot, type CreateBotInput, type ToolInfo, type UpdateBotInput } from "@mrog/shared";

import { api } from "../lib/api";

export const BOTS_KEY = ["bots"] as const;

/** Applies one bot to the cached list; shared by mutation results and stream events. */
export function upsertBot(client: QueryClient, bot: Bot) {
  client.setQueryData<Bot[]>(BOTS_KEY, (old) =>
    old ? [...old.filter((existing) => existing.id !== bot.id), bot].toSorted(compareBots) : old,
  );
}

export function removeBot(client: QueryClient, id: string) {
  client.setQueryData<Bot[]>(BOTS_KEY, (old) => old?.filter((bot) => bot.id !== id));
}

export function useBots() {
  return useQuery({
    queryKey: BOTS_KEY,
    queryFn: async () => (await api<{ bots: Bot[] }>("/bots")).bots,
  });
}

export const botToolsKey = (botId: string) => ["bot-tools", botId] as const;

/** The tools a bot has, on or off, for the Details panel. Looked at again each time the panel opens. */
export function useBotTools(botId: string) {
  return useQuery({
    queryKey: botToolsKey(botId),
    queryFn: async () => (await api<{ tools: ToolInfo[] }>(`/bots/${botId}/tools`)).tools,
    refetchOnMount: "always",
  });
}

export function useCreateBot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateBotInput) =>
      (await api<{ bot: Bot }>("/bots", { method: "POST", body: input })).bot,
    onSuccess: (bot) => upsertBot(client, bot),
  });
}

export function useUpdateBot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateBotInput }) =>
      (await api<{ bot: Bot }>(`/bots/${id}`, { method: "PATCH", body: patch })).bot,
    onSuccess: (bot) => upsertBot(client, bot),
  });
}

export function useDeleteBot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api<void>(`/bots/${id}`, { method: "DELETE" });
      return id;
    },
    onSuccess: (id) => removeBot(client, id),
  });
}
