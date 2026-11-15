import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type {
  Bot,
  ClientKeyName,
  ClientProject,
  CreateClientBotInput,
  LeadColumn,
  LeadKind,
  ListEntry,
  ListName,
  LookalikeProfile,
  ReactToLeadInput,
  UpdateOfferInput,
} from "@mrog/shared";

import { api } from "../lib/api";
import { downloadText } from "../lib/download";
import { harnessInfo } from "../lib/harness";
import { useUi } from "../state";
import { BOTS_KEY, upsertBot } from "./bots";
import { THREADS_KEY } from "./threads";

const clientKey = (botId: string) => ["client", botId] as const;
const KEYS_KEY = ["client-keys"] as const;

export function setClientProject(client: QueryClient, project: ClientProject) {
  client.setQueryData(clientKey(project.botId), project);
}

/** A desktop notice when a scan starts waiting for you and you aren't looking at its chat. */
export function noticeClient(client: QueryClient, project: ClientProject) {
  const before = client.getQueryData<ClientProject>(clientKey(project.botId));
  if (project.status !== "waiting_for_you" || before?.status === "waiting_for_you") return;
  const bot = client.getQueryData<Bot[]>(BOTS_KEY)?.find((candidate) => candidate.id === project.botId);
  if (!bot?.notifications || typeof Notification === "undefined") return;
  if (document.hasFocus() && useUi.getState().selectedThreadId === bot.threadId) return;
  const notification = new Notification(bot.name, {
    body: project.handoff?.reason ?? "A page needs you.",
    silent: false,
  });
  notification.addEventListener("click", () => {
    window.focus();
    useUi.getState().select(bot.threadId);
  });
}

export function useClientProject(botId: string, enabled: boolean) {
  return useQuery({
    queryKey: clientKey(botId),
    queryFn: async () => (await api<{ project: ClientProject }>(`/bots/${botId}/client`)).project,
    enabled,
  });
}

export function useCreateClientBot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateClientBotInput) =>
      api<{ bot: Bot; project: ClientProject }>("/client-bots", { method: "POST", body: input }),
    onSuccess: ({ bot, project }) => {
      upsertBot(client, bot);
      setClientProject(client, project);
      void client.invalidateQueries({ queryKey: BOTS_KEY });
      void client.invalidateQueries({ queryKey: THREADS_KEY });
    },
  });
}

function useClientAction<Input = void>(
  botId: string,
  path: (input: Input) => string,
  method: "POST" | "PATCH" = "POST",
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Input) =>
      api<{ project: ClientProject }>(`/bots/${botId}/client${path(input)}`, {
        method,
        ...(input && typeof input === "object" && "body" in input
          ? { body: (input as { body: unknown }).body }
          : {}),
      }),
    onSuccess: ({ project }) => setClientProject(client, project),
  });
}

export const useUpdateOffer = (botId: string) =>
  useClientAction<{ body: UpdateOfferInput }>(botId, () => "/profile", "PATCH");
export const useApproveOffer = (botId: string) => useClientAction(botId, () => "/profile/approve");
export const useStartClientScan = (botId: string) =>
  useClientAction<{ body: { target: number; kinds: LeadKind[] } }>(botId, () => "/scan");
export const useStopClient = (botId: string) => useClientAction(botId, () => "/stop");
export const useAnswerClientHandoff = (botId: string) =>
  useClientAction<{ body: { action: "continue" | "skip" } }>(botId, () => "/handoff");
export const useReactToLead = (botId: string) =>
  useClientAction<{ leadId: string; body: ReactToLeadInput }>(
    botId,
    ({ leadId }) => `/leads/${leadId}/react`,
  );
export const useMoveLead = (botId: string) =>
  useClientAction<{ leadId: string; body: { column: LeadColumn } }>(
    botId,
    ({ leadId }) => `/leads/${leadId}`,
    "PATCH",
  );
export const useLeadNote = (botId: string) =>
  useClientAction<{ leadId: string; body: { note: string } }>(botId, ({ leadId }) => `/leads/${leadId}/note`);
export const useWatchLead = (botId: string) =>
  useClientAction<{ leadId: string; body: { watch: boolean } }>(
    botId,
    ({ leadId }) => `/leads/${leadId}/watch`,
  );
export const useForgetLead = (botId: string) =>
  useClientAction<{ leadId: string; body: { block: boolean } }>(
    botId,
    ({ leadId }) => `/leads/${leadId}/forget`,
  );
export const useAnswerOfferSuggestion = (botId: string) =>
  useClientAction<{ id: string; body: { accept: boolean } }>(botId, ({ id }) => `/suggestions/${id}`);
export const useAddToList = (botId: string) =>
  useClientAction<{ body: { list: ListName; text: string } }>(botId, () => "/lists/add");
export const useRemoveFromList = (botId: string) =>
  useClientAction<{ body: { list: ListName; entry: ListEntry } }>(botId, () => "/lists/remove");
export const useSetLookalikes = (botId: string) =>
  useClientAction<{ body: { text: string } }>(botId, () => "/lookalikes");
export const useUpdateLookalike = (botId: string) =>
  useClientAction<{ body: { profile: Partial<LookalikeProfile>; approved: boolean } }>(
    botId,
    () => "/lookalikes",
    "PATCH",
  );
export const useWatchList = (botId: string) =>
  useClientAction<{ body: { off: boolean } }>(botId, () => "/watchlist");

/** Which register keys are saved (the keys themselves never come back). */
export function useClientKeys() {
  return useQuery({
    queryKey: KEYS_KEY,
    queryFn: async () => (await api<{ keys: Record<ClientKeyName, boolean> }>("/client-bots/keys")).keys,
  });
}

export function useSetClientKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: ClientKeyName; key: string }) =>
      api<{ keys: Record<ClientKeyName, boolean> }>("/client-bots/keys", { method: "POST", body: input }),
    onSuccess: ({ keys }) => client.setQueryData(KEYS_KEY, keys),
  });
}

/** The board as a CSV file. */
export async function exportLeads(botId: string, name: string) {
  const harness = harnessInfo();
  if (!harness) throw new Error("The harness address is unknown.");
  const res = await fetch(`${harness.url}/api/bots/${botId}/client/export.csv`, {
    headers: { authorization: `Bearer ${harness.token}` },
  });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  downloadText(
    `${name.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "leads"} leads.csv`,
    await res.text(),
    "text/csv",
  );
}
