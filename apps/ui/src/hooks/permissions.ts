import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AgentSettings, PermissionRule, Permissions } from "@mrog/shared";

import { api } from "../lib/api";

const PERMISSIONS_KEY = ["permissions"] as const;

export function usePermissions() {
  return useQuery({
    queryKey: PERMISSIONS_KEY,
    queryFn: async () => (await api<{ permissions: Permissions }>("/permissions")).permissions,
  });
}

export function useSavePermissions() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (permissions: Permissions) =>
      (await api<{ permissions: Permissions }>("/permissions", { method: "PUT", body: permissions }))
        .permissions,
    onSuccess: (permissions) => client.setQueryData(PERMISSIONS_KEY, permissions),
  });
}

export function useAddRule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (rule: Pick<PermissionRule, "tool" | "match" | "decision">) =>
      api<{ rule: PermissionRule }>("/permissions/rules", { method: "POST", body: rule }),
    onSuccess: () => void client.invalidateQueries({ queryKey: PERMISSIONS_KEY }),
  });
}

export function useDeleteRule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/permissions/rules/${id}`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: PERMISSIONS_KEY }),
  });
}

export function useAgentSettings() {
  return useQuery({
    queryKey: ["agent-settings"],
    queryFn: async () => (await api<{ settings: AgentSettings }>("/agent-settings")).settings,
  });
}

export function useSaveAgentSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (settings: AgentSettings) => api("/agent-settings", { method: "PUT", body: settings }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["agent-settings"] }),
  });
}
