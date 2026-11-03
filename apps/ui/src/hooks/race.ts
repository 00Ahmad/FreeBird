import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type { CreateRaceInput, Race, Thread } from "@mrog/shared";

import { api } from "../lib/api";
import { BOTS_KEY } from "./bots";
import { upsertThread } from "./threads";

const raceKey = (threadId: string) => ["race", threadId] as const;

export function setRace(client: QueryClient, race: Race) {
  client.setQueryData(raceKey(race.threadId), race);
}

export function useRace(threadId: string, enabled: boolean) {
  return useQuery({
    queryKey: raceKey(threadId),
    queryFn: async () => (await api<{ race: Race | null }>(`/threads/${threadId}/race`)).race,
    enabled,
  });
}

export function useStartRace() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRaceInput) =>
      api<{ thread: Thread; race: Race }>("/races", { method: "POST", body: input }),
    onSuccess: ({ thread, race }) => {
      upsertThread(client, thread);
      setRace(client, race);
      void client.invalidateQueries({ queryKey: BOTS_KEY });
    },
  });
}

export function useJudgeNow(threadId: string) {
  return useMutation({ mutationFn: () => api<void>(`/threads/${threadId}/race/judge`, { method: "POST" }) });
}

export function useStopRace(threadId: string) {
  return useMutation({ mutationFn: () => api<void>(`/threads/${threadId}/race/stop`, { method: "POST" }) });
}
