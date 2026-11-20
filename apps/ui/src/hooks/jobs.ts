import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type {
  Bot,
  CreateJobBotInput,
  JobColumn,
  JobProject,
  ReactToJobInput,
  UpdateJobProfileInput,
} from "@mrog/shared";

import { api } from "../lib/api";
import { isScanning } from "../lib/jobs";
import { useUi } from "../state";
import { BOTS_KEY, upsertBot } from "./bots";
import { THREADS_KEY } from "./threads";

const jobKey = (botId: string) => ["job", botId] as const;

/** Applies a project to the cache; shared by action results and the `job.updated` event. */
export function setJobProject(client: QueryClient, project: JobProject) {
  client.setQueryData(jobKey(project.botId), project);
}

/**
 * A desktop notice when a scan starts waiting for you (a CAPTCHA, a sign-in), or when it ends, and you aren't looking at
 * its chat. (A Job Bot's chat messages raise no reply notice of their own, so this is the only one.)
 */
export function noticeJob(client: QueryClient, project: JobProject) {
  const before = client.getQueryData<JobProject>(jobKey(project.botId));
  const waits = project.status === "waiting_for_you" && before?.status !== "waiting_for_you";
  // A scan that has just ended (not a check of the board, which leaves the last scan as it was).
  const ended =
    !!before &&
    isScanning(before) &&
    !isScanning(project) &&
    !!project.scan?.endedAt &&
    project.scan.endedAt !== before.scan?.endedAt &&
    !!project.scan.stopReason;
  if (!waits && !ended) return;
  const bot = client.getQueryData<Bot[]>(BOTS_KEY)?.find((candidate) => candidate.id === project.botId);
  if (!bot?.notifications || typeof Notification === "undefined") return;
  if (document.hasFocus() && useUi.getState().selectedThreadId === bot.threadId) return;
  const notification = new Notification(bot.name, {
    body: waits
      ? (project.handoff?.reason ?? "A page needs you.")
      : `Scan ${project.scan!.number} ended: ${project.scan!.stopReason}`,
    silent: false,
  });
  notification.addEventListener("click", () => {
    window.focus();
    useUi.getState().select(bot.threadId);
  });
}

export function useJobProject(botId: string, enabled: boolean) {
  return useQuery({
    queryKey: jobKey(botId),
    queryFn: async () => (await api<{ project: JobProject }>(`/bots/${botId}/job`)).project,
    enabled,
  });
}

/** Makes the Job Bot, its hidden role bots and their conversations. */
export function useCreateJobBot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateJobBotInput) =>
      api<{ bot: Bot; project: JobProject }>("/job-bots", { method: "POST", body: input }),
    onSuccess: ({ bot, project }) => {
      upsertBot(client, bot);
      setJobProject(client, project);
      void client.invalidateQueries({ queryKey: BOTS_KEY });
      void client.invalidateQueries({ queryKey: THREADS_KEY });
    },
  });
}

/** One action on a Job Bot; the answer is the project as it is now. */
function useJobAction<Input = void>(
  botId: string,
  path: (input: Input) => string,
  method: "POST" | "PATCH" = "POST",
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Input) =>
      api<{ project: JobProject }>(`/bots/${botId}/job${path(input)}`, {
        method,
        ...(input && typeof input === "object" && "body" in input
          ? { body: (input as { body: unknown }).body }
          : {}),
      }),
    onSuccess: ({ project }) => setJobProject(client, project),
  });
}

export const useUpdateJobProfile = (botId: string) =>
  useJobAction<{ body: UpdateJobProfileInput }>(botId, () => "/profile", "PATCH");
export const useApproveJobProfile = (botId: string) => useJobAction(botId, () => "/profile/approve");
export const useStartJobScan = (botId: string) =>
  useJobAction<{ body: { target: number } }>(botId, () => "/scan");
export const useStopJob = (botId: string) => useJobAction(botId, () => "/stop");
/** Reads the board's open jobs again (no model) and marks the ones gone or closed. */
export const useCheckOpen = (botId: string) => useJobAction(botId, () => "/check-open");
export const useAnswerHandoff = (botId: string) =>
  useJobAction<{ body: { action: "continue" | "skip" } }>(botId, () => "/handoff");
export const useReactToJob = (botId: string) =>
  useJobAction<{ cardId: string; body: ReactToJobInput }>(botId, ({ cardId }) => `/cards/${cardId}/react`);
export const useMoveJob = (botId: string) =>
  useJobAction<{ cardId: string; body: { column: JobColumn } }>(
    botId,
    ({ cardId }) => `/cards/${cardId}`,
    "PATCH",
  );
export const useAnswerSuggestion = (botId: string) =>
  useJobAction<{ id: string; body: { accept: boolean } }>(botId, ({ id }) => `/suggestions/${id}`);
