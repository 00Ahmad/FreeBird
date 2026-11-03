import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  AddConnectorInput,
  BotComputer,
  BrowserSettings,
  BrowserStatus,
  ComputerStatus,
  ConnectorView,
  NewVaultItem,
  Routine,
  RoutineInput,
  UpdateConnectorInput,
  VaultItem,
  VoiceSettings,
} from "@mrog/shared";

import { api } from "../lib/api";

function useInvalidate(key: string) {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: [key] });
}

// ---- routines ------------------------------------------------------------------------------------------
export function useRoutines(botId?: string) {
  return useQuery({
    queryKey: ["routines", botId ?? "all"],
    queryFn: async () =>
      (await api<{ routines: Routine[] }>(`/routines${botId ? `?botId=${botId}` : ""}`)).routines,
  });
}

export function useRoutineActions() {
  const invalidate = useInvalidate("routines");
  return {
    save: useMutation({
      mutationFn: ({ id, input }: { id?: string; input: Partial<RoutineInput> }) =>
        id
          ? api(`/routines/${id}`, { method: "PATCH", body: input })
          : api("/routines", { method: "POST", body: input }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/routines/${id}`, { method: "DELETE" }),
      onSuccess: invalidate,
    }),
    run: useMutation({
      mutationFn: (id: string) => api(`/routines/${id}/run`, { method: "POST" }),
      onSuccess: invalidate,
    }),
  };
}

// ---- connected apps ------------------------------------------------------------------------------------
export function useConnectors() {
  return useQuery({
    queryKey: ["connectors"],
    queryFn: async () => (await api<{ connectors: ConnectorView[] }>("/connectors")).connectors,
  });
}

export function useConnectorActions() {
  const invalidate = useInvalidate("connectors");
  return {
    add: useMutation({
      mutationFn: (input: AddConnectorInput) => api("/connectors", { method: "POST", body: input }),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: UpdateConnectorInput }) =>
        api(`/connectors/${id}`, { method: "PATCH", body: patch }),
      onSuccess: invalidate,
    }),
    reconnect: useMutation({
      mutationFn: (id: string) => api(`/connectors/${id}/reconnect`, { method: "POST" }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/connectors/${id}`, { method: "DELETE" }),
      onSuccess: invalidate,
    }),
  };
}

// ---- vault ---------------------------------------------------------------------------------------------
export function useVault() {
  return useQuery({
    queryKey: ["vault"],
    queryFn: async () => (await api<{ items: VaultItem[] }>("/vault")).items,
  });
}

export function useVaultActions() {
  const invalidate = useInvalidate("vault");
  return {
    add: useMutation({
      mutationFn: (item: NewVaultItem) => api("/vault", { method: "POST", body: item }),
      onSuccess: invalidate,
    }),
    importCsv: useMutation({
      mutationFn: (csv: string) =>
        api<{ imported: number; skipped: number }>("/vault/import", { method: "POST", body: { csv } }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/vault/${id}`, { method: "DELETE" }),
      onSuccess: invalidate,
    }),
  };
}

// ---- computer ------------------------------------------------------------------------------------------
export function useComputerStatus() {
  return useQuery({
    queryKey: ["computer", "status"],
    queryFn: () => api<ComputerStatus>("/computer"),
    staleTime: 15_000,
  });
}

export function useBotComputer(botId: string) {
  return useQuery({
    queryKey: ["computer", botId],
    queryFn: async () => (await api<{ computer: BotComputer }>(`/bots/${botId}/computer`)).computer,
    refetchInterval: (query) => (query.state.data?.state === "starting" ? 3000 : false),
  });
}

export function useComputerAction(botId: string) {
  const invalidate = useInvalidate("computer");
  return useMutation({
    mutationFn: (action: "start" | "stop" | "reset") =>
      api<{ computer: BotComputer }>(`/bots/${botId}/computer/${action}`, { method: "POST" }),
    onSettled: invalidate,
  });
}

// ---- voice ---------------------------------------------------------------------------------------------
export function useVoiceSettings() {
  return useQuery({
    queryKey: ["voice"],
    queryFn: async () => (await api<{ settings: VoiceSettings }>("/voice")).settings,
  });
}

export function useSaveVoice() {
  const invalidate = useInvalidate("voice");
  return useMutation({
    mutationFn: (settings: VoiceSettings) => api("/voice", { method: "PUT", body: settings }),
    onSuccess: invalidate,
  });
}

// ---- browser -------------------------------------------------------------------------------------------
export function useBrowser() {
  return useQuery({
    queryKey: ["browser"],
    queryFn: () => api<{ settings: BrowserSettings; status: BrowserStatus }>("/browser"),
  });
}

export function useBrowserActions() {
  const invalidate = useInvalidate("browser");
  return {
    save: useMutation({
      mutationFn: (settings: BrowserSettings) => api("/browser/settings", { method: "PUT", body: settings }),
      onSuccess: invalidate,
    }),
    open: useMutation({
      mutationFn: () => api("/browser/open", { method: "POST" }),
      onSettled: invalidate,
    }),
    close: useMutation({
      mutationFn: () => api("/browser/close", { method: "POST" }),
      onSettled: invalidate,
    }),
    saveKey: useMutation({
      mutationFn: ({ name, value }: { name: string; value: string }) =>
        api(`/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: { value } }),
    }),
  };
}
