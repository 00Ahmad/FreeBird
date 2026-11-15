import { missingForApproval } from "@mrog/jobs";
import { MAX_JOB_TARGET, messageText, type Message } from "@mrog/shared";

import type { Services } from "../services";
import { interviewTask, saveTask } from "./roles/interviewer";
import { openPhase } from "./phase";
import { Halt, type RoleRunner } from "./run-role";
import type { JobState } from "./state";

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

/** How many jobs a message asks for (a number from 1 to MAX_JOB_TARGET, in digits or a common word), or null. */
export function countIn(text: string): number | null {
  const digits = /\b(\d{1,3})\b/.exec(text);
  const word =
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty)\b/i.exec(text);
  const n = digits ? Number(digits[1]) : word ? NUMBER_WORDS[word[1]!.toLowerCase()]! : null;
  return n !== null && n >= 1 && n <= MAX_JOB_TARGET ? n : null;
}

/** Whether a message asks for a scan ("search", "find me jobs", "scan"). */
export const asksForScan = (text: string) => /\b(scan|search|find|look for|hunt)\b/i.test(text);
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
      const reply = await roles.run(
        botId,
        "interviewer",
        interviewTask(project.profile, said, first),
        controller.signal,
        {
          capture: { base: project.profile },
          ...(phase ? { phase } : {}),
        },
      );
      // A reply that saved nothing gets one more, short turn that only saves.
      const capture = reply.capture;
      if (!capture.profile && !reply.error && said.trim().length > 0) {
        phase?.say("Saving what you told me…");
        await roles.run(botId, "interviewer", saveTask(project.profile, said), controller.signal, {
          capture,
          ...(phase ? { phase } : {}),
        });
      }
      const profile = capture.profile;
      const after = state.change(botId, (p) => {
        if (profile) {
          p.profile = profile;
          state.logLine(p, "Profile updated");
        }
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
      phase?.close(`${words}${ready}`);
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
      const count = countIn(text);
      if (project.askingCount && count !== null) return deps.startScan(botId, count);
      if (asksForScan(text)) return count !== null ? deps.startScan(botId, count) : askCount(botId);
      if (project.askingCount) state.change(botId, (p) => void (p.askingCount = false));
    }
    void interview(botId, text).catch(() => undefined);
  };

  return { hear, interview };
}
