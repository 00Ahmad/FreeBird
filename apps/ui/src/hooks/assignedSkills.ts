import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../lib/api";

/** The skills a bot applies on every turn, and whether they are still its defaults. */
export interface AssignedSkillNames {
  names: string[];
  defaults: boolean;
}

/** Under "skills", so a change to any skill (one deleted, say) refreshes it too. */
const assignedKey = (botId: string) => ["skills", "assigned", botId] as const;

export function useAssignedSkills(botId: string) {
  return useQuery({
    queryKey: assignedKey(botId),
    queryFn: () => api<AssignedSkillNames>(`/bots/${botId}/assigned-skills`),
  });
}

export function useSetAssignedSkills(botId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (names: string[]) =>
      api<AssignedSkillNames>(`/bots/${botId}/assigned-skills`, { method: "PUT", body: { names } }),
    onSuccess: (saved) => client.setQueryData(assignedKey(botId), saved),
  });
}
