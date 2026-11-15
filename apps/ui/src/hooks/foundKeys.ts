import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { FoundKey, ProviderView } from "@mrog/shared";

import { api } from "../lib/api";
import { MODELS_KEY } from "./runtime";

// Under "providers", so whatever refreshes the provider list (adding, removing, a change pushed by the harness)
// refreshes this too: a provider removed is offered again, one added is not.
const FOUND_KEY = ["providers", "found"] as const;

/** API keys the harness found in the user's environment variables, by name only. */
export function useFoundKeys() {
  return useQuery({
    queryKey: FOUND_KEY,
    queryFn: () => api<{ found: FoundKey[] }>("/providers/found"),
  });
}

/** Adds a found key's provider; the harness reads the key itself, so nothing is sent but which one. */
export function useAddFoundKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (preset: string) =>
      api<{ provider: ProviderView }>(`/providers/found/${encodeURIComponent(preset)}`, { method: "POST" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["providers"] });
      void client.invalidateQueries({ queryKey: MODELS_KEY });
    },
  });
}
