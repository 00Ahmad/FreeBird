import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ModelInfo, RuntimeSettings, RuntimeStatus } from "@mrog/shared";

import { api } from "../lib/api";

export const RUNTIME_KEY = ["runtime"] as const;
export const MODELS_KEY = ["models"] as const;

export function useRuntime() {
  return useQuery({
    queryKey: RUNTIME_KEY,
    queryFn: async () => (await api<{ status: RuntimeStatus }>("/runtime")).status,
  });
}

export function useModels() {
  return useQuery({
    queryKey: MODELS_KEY,
    queryFn: () => api<{ models: ModelInfo[]; errors: { providerId: string; message: string }[] }>("/models"),
  });
}

export function useUpdateRuntime() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<RuntimeSettings>) =>
      (await api<{ settings: RuntimeSettings }>("/runtime/settings", { method: "PATCH", body: patch }))
        .settings,
    onSuccess: (settings, patch) => {
      client.setQueryData<RuntimeStatus>(RUNTIME_KEY, (old) => (old ? { ...old, settings } : old));
      if (patch.ollamaUrl) void client.invalidateQueries({ queryKey: MODELS_KEY });
      void client.invalidateQueries({ queryKey: RUNTIME_KEY });
    },
  });
}

export function usePullModel() {
  return useMutation({
    mutationFn: (model: string) =>
      api<{ started: boolean }>("/runtime/pull", { method: "POST", body: { model } }),
  });
}

export function useCancelPull() {
  return useMutation({
    mutationFn: (model: string) => api<void>("/runtime/pull/cancel", { method: "POST", body: { model } }),
  });
}

export function useUnloadModel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (model: string) => api<void>("/runtime/unload", { method: "POST", body: { model } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: RUNTIME_KEY }),
  });
}

export function useWarmup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ warmed: boolean }>("/runtime/warmup", { method: "POST" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: RUNTIME_KEY }),
  });
}

export function useStartOllama() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ started: boolean }>("/runtime/start", { method: "POST" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: RUNTIME_KEY });
      void client.invalidateQueries({ queryKey: MODELS_KEY });
    },
  });
}

/** Model a bot actually runs on: its own pick, or the shared one. */
export function effectiveModel(botModel: string | null, status: RuntimeStatus | undefined): string | null {
  return botModel ?? status?.settings.sharedModel ?? null;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}
