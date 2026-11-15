import { missingForScan } from "@mrog/clients";
import { MAX_CLIENT_TARGET, messageText, type Message } from "@mrog/shared";

import { asksForScan, countIn } from "../jobs/chat";
import { openPhase } from "../jobs/phase";
import type { Services } from "../services";
import { interviewTask, saveTask } from "./roles/interviewer";
import { Halt, type RoleRunner } from "./run-role";
import type { ClientState } from "./state";

const asksToStop = (text: string) => /^\s*(stop|cancel|halt)\b/i.test(text);

export interface ChatDeps {
  services: Services;
  state: ClientState;
  roles: RoleRunner;
  startScan(botId: string, target: number): void;
  stop(botId: string): Promise<unknown>;
}

/**
 * What the Client Bot does with a message in its own chat. The Interviewer answers (and may change the profile); a
 * request for a scan asks how many new leads to find, and a number then starts it.
 */
export function createChat(deps: ChatDeps) {
  const { services, state, roles } = deps;
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
      `How many new leads should I find this time? Say a number from 1 to ${MAX_CLIENT_TARGET} (last time: ${project?.lastTarget}).`,
    );
  };

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
        if (p.status === "interview" && missingForScan(p.profile).length === 0) {
          p.status = "awaiting_profile";
          p.note = "Your profile is ready: approve it on the profile card to start finding clients.";
        }
      });
      const words = reply.error
        ? `I couldn't answer: ${reply.error}`
        : reply.text ||
          (profile ? "Saved. What else should I know?" : "Tell me what you sell and who you sell it to.");
      const ready =
        after?.status === "awaiting_profile"
          ? "\n\nYour profile has what a scan needs: approve it on the profile card when you're happy with it."
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
          `I'm scanning: ${project.scan?.found ?? 0} of ${project.scan?.target ?? 0} new leads found so far. Press Stop (or say stop) to end the scan.`,
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
