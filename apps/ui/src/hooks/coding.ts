import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type {
  Bot,
  CodingProject,
  CreateCodingBotInput,
  ReviseCodingInput,
  UpdateCodingSettingsInput,
} from "@mrog/shared";

import { useCardActivity } from "../codingActivity";
import { api } from "../lib/api";
import type { ImportPreview } from "../lib/codingImport";
import { BOTS_KEY, upsertBot } from "./bots";
import { THREADS_KEY } from "./threads";

const codingKey = (botId: string) => ["coding", botId] as const;

/** Applies a project to the cache; shared by mutation results and the `coding.updated` event. */
export function setCodingProject(client: QueryClient, project: CodingProject) {
  client.setQueryData(codingKey(project.botId), project);
  useCardActivity.getState().advance(project);
}

export function useCodingProject(botId: string, enabled: boolean) {
  return useQuery({
    queryKey: codingKey(botId),
    queryFn: async () => {
      const { project } = await api<{ project: CodingProject }>(`/bots/${botId}/coding`);
      // The first sight of a board is the starting point the next change is compared with.
      useCardActivity.getState().advance(project);
      return project;
    },
    enabled,
  });
}

/** Makes the Coding Bot, its three hidden role bots and their conversations. */
export function useCreateCodingBot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCodingBotInput) =>
      api<{ bot: Bot; project: CodingProject }>("/coding-bots", { method: "POST", body: input }),
    onSuccess: ({ bot, project }) => {
      upsertBot(client, bot);
      setCodingProject(client, project);
      // The role bots and their conversations arrive on the event stream too; this makes sure the lists have them.
      void client.invalidateQueries({ queryKey: BOTS_KEY });
      void client.invalidateQueries({ queryKey: THREADS_KEY });
    },
  });
}

/** One action on a project; the answer is the project as it is now. */
function useCodingAction<Input = void>(send: (input: Input) => Promise<{ project: CodingProject }>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: ({ project }) => setCodingProject(client, project),
  });
}

export const useApproveCoding = (botId: string) =>
  useCodingAction(() => api<{ project: CodingProject }>(`/bots/${botId}/coding/approve`, { method: "POST" }));

export const useReviseCoding = (botId: string) =>
  useCodingAction((input: ReviseCodingInput) =>
    api<{ project: CodingProject }>(`/bots/${botId}/coding/revise`, { method: "POST", body: input }),
  );

export const useStopCoding = (botId: string) =>
  useCodingAction(() => api<{ project: CodingProject }>(`/bots/${botId}/coding/stop`, { method: "POST" }));

export const useResumeCoding = (botId: string) =>
  useCodingAction(() => api<{ project: CodingProject }>(`/bots/${botId}/coding/resume`, { method: "POST" }));

export const useUpdateCodingSettings = (botId: string) =>
  useCodingAction((input: UpdateCodingSettingsInput) =>
    api<{ project: CodingProject }>(`/bots/${botId}/coding/settings`, { method: "PATCH", body: input }),
  );

/** What the server says about a plan to import; `project` is set only once it has been applied. */
export interface ImportResult {
  preview: ImportPreview;
  project: CodingProject | null;
}

/** Reads a plan (a file's text, a chat reply, or an object) into the project. `dryRun` only previews it. */
export function useImportCoding(botId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { plan: unknown; dryRun?: boolean; replace?: boolean }) =>
      api<ImportResult>(`/bots/${botId}/coding/import`, { method: "POST", body: input }),
    onSuccess: ({ project }) => {
      if (project) setCodingProject(client, project);
    },
  });
}
