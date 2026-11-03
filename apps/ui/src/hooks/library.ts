import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { LibraryItem } from "@mrog/shared";

import { api } from "../lib/api";

const KEY = ["library"] as const;

export function useLibrary() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => (await api<{ items: LibraryItem[] }>("/library")).items,
  });
}

export function useLibraryActions() {
  const client = useQueryClient();
  const invalidate = () => void client.invalidateQueries({ queryKey: KEY });
  return {
    save: useMutation({
      mutationFn: (messageId: string) =>
        api<{ item: LibraryItem }>("/library", { method: "POST", body: { messageId } }),
      onSuccess: invalidate,
    }),
    rename: useMutation({
      mutationFn: ({ id, title }: { id: string; title: string }) =>
        api(`/library/${id}`, { method: "PATCH", body: { title } }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/library/${id}`, { method: "DELETE" }),
      onSuccess: invalidate,
    }),
  };
}
