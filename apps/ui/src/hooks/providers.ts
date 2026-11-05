import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  parseModelRef,
  type AddProviderInput,
  type ProviderPreset,
  type ProviderView,
  type UpdateProviderInput,
} from "@mrog/shared";

import { api } from "../lib/api";
import { MODELS_KEY } from "./runtime";

const PROVIDERS_KEY = ["providers"] as const;

export function useProviders() {
  return useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => api<{ providers: ProviderView[]; presets: ProviderPreset[] }>("/providers"),
  });
}

/** Whether a model (a "provider:model" ref) runs on this computer, which decides how long a silent reply is normal. */
export function useModelIsLocal(ref: string | null | undefined): boolean {
  const { data } = useProviders();
  if (!ref) return true;
  const providerId = parseModelRef(ref).providerId;
  return (
    providerId === "ollama" ||
    (data?.providers.find((provider) => provider.id === providerId)?.local ?? false)
  );
}

function useInvalidate() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: PROVIDERS_KEY });
    void client.invalidateQueries({ queryKey: MODELS_KEY });
  };
}

export function useAddProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: AddProviderInput) =>
      api<{ provider: ProviderView }>("/providers", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateProviderInput }) =>
      api<{ provider: ProviderView }>(`/providers/${id}`, { method: "PATCH", body: patch }),
    onSuccess: invalidate,
  });
}

export function useRemoveProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/providers/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

export function useTestProvider() {
  // A test refreshes the harness's model list; show the new one.
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<{ models: number }>(`/providers/${id}/test`, { method: "POST" }),
    onSettled: invalidate,
  });
}

export function useUsage() {
  return useQuery({
    queryKey: ["usage"],
    queryFn: () =>
      api<{
        bots: { botId: string; inputTokens: number; outputTokens: number; messages: number }[];
        localProviders: string[];
      }>("/usage"),
    staleTime: 10_000,
  });
}
