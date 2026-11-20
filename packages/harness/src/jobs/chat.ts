import { describeChange, missingForApproval, nextInterviewState, skipsQuestion } from "@mrog/jobs";
import { MAX_JOB_TARGET, messageText, type Message } from "@mrog/shared";

import type { Services } from "../services";
import { lastQuestion } from "../teams/last-question";
import { rescoreBoard } from "./board";
import { interviewTask, saveTask } from "./roles/interviewer";
import { openPhase } from "./phase";
import { countIn, scanIntent, SCAN_OR_PROFILE } from "./scan-words";
import { Halt, type RoleRunner } from "./run-role";
import type { JobState } from "./state";

export { asksForScan, countIn } from "./scan-words";

const asksToStop = (text: string) => /^\s*(stop|cancel|halt)\b/i.test(text);

export interface ChatDeps {
  services: Services;
  state: JobState;
  roles: RoleRunner;
  startScan(botId: string, target: number): void;
  stop(botId: string): Promise<unknown>;
}

/**
 * What the Job Bot does with a message in its own chat. During the interview (and later, to change the profile) the
 * Interviewer answers; a request for a scan asks how many new jobs to find, and a number then starts it.
 */
export function createChat(deps: ChatDeps) {
  const { services, state, roles } = deps;
  /** Job Bots whose Interviewer is answering now: one reply at a time. */
  const talking = new Set<string>();
  const stops = new Map<string, AbortController>();
  services.disposers.push(() => {
    for (const controller of stops.values()) controller.abort();
  });

  const askCount = (botId: string) => {
    const project = state.change(botId, (p) => {
      p.askingCount = true;
    });
    state.say(
      botId,
      `How many new jobs should I find this time? Say a number from 1 to ${MAX_JOB_TARGET} (last time: ${project?.lastTarget}).`,
    );
  };

  /** The Interviewer's reply to what you said; it may change the profile. */
  const interview = async (botId: string, said: string) => {
    if (talking.has(botId)) {
      state.say(botId, "One moment: I'm still answering your last message.");
      return;
    }
    talking.add(botId);
    const controller = new AbortController();
    stops.set(botId, controller);
    const phase = openPhase(services, botId, "Thinking…");
    try {
      const project = state.need(botId);
      const first = project.log.length <= 1 && project.status === "interview";
      // The question being answered, and the topics asked or skipped so far: a turn reads nothing earlier.
      const lastAsked = lastQuestion(services, botId);
      const topics = nextInterviewState(project.interview, lastAsked, said);
      state.change(botId, (p) => void (p.interview = topics));
      const reply = await roles.run(
        botId,
        "interviewer",
        interviewTask(project.profile, said, first, { lastAsked, ...topics }),
        controller.signal,
        {
          capture: { base: project.profile, said },
          ...(phase ? { phase } : {}),
        },
      );
      // A reply that saved nothing gets one more, short turn that only saves.
      const capture = reply.capture;
      // A skip has nothing to save: no second turn asking to save it.
      if (!capture.profile && !reply.error && said.trim().length > 0 && !skipsQuestion(said)) {
        phase?.say("Saving what you told me…");
        await roles.run(botId, "interviewer", saveTask(project.profile, said), controller.signal, {
          capture,
          ...(phase ? { phase } : {}),
        });
      }
      const profile = capture.profile;
      // What changed, said plainly, so a wrong save is seen at once.
      const changes = profile ? describeChange(project.profile, profile) : [];
      const after = state.change(botId, (p) => {
        if (profile) {
          p.profile = profile;
          rescoreBoard(p);
          state.logLine(p, changes.length > 0 ? `Profile: ${changes.join("; ")}` : "Profile updated");
        }
        if (capture.dropped?.length)
          state.logLine(p, `Not saved, because you didn't say it: ${capture.dropped.join("; ")}`);
        if (p.status === "interview" && missingForApproval(p.profile).length === 0) {
          p.status = "awaiting_profile";
          p.note = "Your profile is ready: approve it on the profile card to start searching.";
        }
      });
      const words = reply.error
        ? `I couldn't answer: ${reply.error}`
        : reply.text || (profile ? "Saved. What else should I know?" : "Tell me about the job you want.");
      const ready =
        after?.status === "awaiting_profile"
          ? "\n\nYour profile has what a search needs: approve it on the profile card when you're happy with it."
          : "";
      const saved = changes.length > 0 ? `\n\n_Saved: ${changes.join("; ")}._` : "";
      phase?.close(`${words}${saved}${ready}`);
    } catch (error) {
      phase?.close(
        error instanceof Halt ? "Stopped." : `Something went wrong: ${(error as Error).message}`,
        "stopped",
      );
      if (!(error instanceof Halt)) throw error;
    } finally {
      talking.delete(botId);
      stops.delete(botId);
    }
  };

  const hear = (botId: string, message: Message) => {
    const project = state.load(botId);
    if (!project) return;
    const text = messageText(message).trim();
    if (!text) {
      state.say(botId, "Send your message as text.");
      return;
    }
    if (project.status === "scanning" || project.status === "waiting_for_you") {
      if (asksToStop(text)) void deps.stop(botId);
      else
        state.say(
          botId,
          `I'm scanning: ${project.scan?.found ?? 0} of ${project.scan?.target ?? 0} new jobs found so far. Press Stop (or say stop) to end the scan.`,
        );
      return;
    }
    if (project.status === "ready" || project.status === "error") {
      const count = countIn(text, { asked: project.askingCount });
      if (project.askingCount && count !== null) return deps.startScan(botId, count);
      const intent = scanIntent(text);
      if (intent === "scan") return count !== null ? deps.startScan(botId, count) : askCount(botId);
      // "Change my search to include Canada", "find jobs paying 40,000": a scan, or a change to the profile?
      if (intent === "unsure") {
        if (project.askingCount) state.change(botId, (p) => void (p.askingCount = false));
        state.say(botId, SCAN_OR_PROFILE);
        return;
      }
      if (project.askingCount) state.change(botId, (p) => void (p.askingCount = false));
    }
    void interview(botId, text).catch(() => undefined);
  };

  return { hear, interview };
}
