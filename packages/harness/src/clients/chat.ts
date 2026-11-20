import { describeOfferChange, kindsFrom, kindsText, missingForScan, OFFER_TOPICS } from "@mrog/clients";
import { nextInterviewState, skipsQuestion } from "@mrog/jobs";
import { MAX_CLIENT_TARGET, messageText, type LeadKind, type Message } from "@mrog/shared";

import { countIn, scanIntent, SCAN_OR_PROFILE } from "../jobs/scan-words";
import { openPhase } from "../jobs/phase";
import type { Services } from "../services";
import { lastQuestion } from "../teams/last-question";
import { suggestFromPrice } from "./board";
import { interviewTask, saveTask } from "./roles/interviewer";
import { Halt, type RoleRunner } from "./run-role";
import type { ClientState } from "./state";

const asksToStop = (text: string) => /^\s*(stop|cancel|halt)\b/i.test(text);

export interface ChatDeps {
  services: Services;
  state: ClientState;
  roles: RoleRunner;
  startScan(botId: string, target: number, kinds?: LeadKind[]): void;
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
    // Which kinds it will look for, said, and changeable in the answer (3.4).
    state.say(
      botId,
      `How many new leads should I find this time? Say a number from 1 to ${MAX_CLIENT_TARGET} (last time: ${project?.lastTarget}). I'll look for ${kindsText(project?.lastKinds ?? [])}; say "10, only tenders" or "5, no quiet fits" to change that.`,
    );
  };

  /** Starts a scan with the kinds the message names, or last time's. */
  const scanWith = (botId: string, count: number, text: string, current: LeadKind[]) => {
    const kinds = kindsFrom(text, current);
    return kinds ? deps.startScan(botId, count, kinds) : deps.startScan(botId, count);
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
      // The question being answered, and the topics asked or skipped so far: a turn reads nothing earlier (4.2, 4.3).
      const lastAsked = lastQuestion(services, botId);
      const topics = nextInterviewState(project.interview, lastAsked, said, OFFER_TOPICS);
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
      // What changed, said plainly (with the kind of service picked), so a wrong save is seen at once (1.7, 4.4).
      const changes = profile ? describeOfferChange(project.profile, profile) : [];
      const after = state.change(botId, (p) => {
        if (profile) {
          p.profile = profile;
          suggestFromPrice(p);
          state.logLine(p, changes.length > 0 ? `Profile: ${changes.join("; ")}` : "Profile updated");
        }
        if (capture.dropped?.length)
          state.logLine(p, `Not saved, because you didn't say it: ${capture.dropped.join("; ")}`);
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
      const saved =
        changes.length > 0
          ? `\n\n_Saved: ${changes.join("; ")}._${
              changes.some((line) => line.startsWith("Kind of service"))
                ? " If that kind of service is wrong, change it on the profile card."
                : ""
            }`
          : "";
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
          `I'm scanning: ${project.scan?.found ?? 0} of ${project.scan?.target ?? 0} new leads found so far. Press Stop (or say stop) to end the scan.`,
        );
      return;
    }
    if (project.status === "ready" || project.status === "error") {
      const count = countIn(text, { asked: project.askingCount, max: MAX_CLIENT_TARGET });
      if (project.askingCount && count !== null) return scanWith(botId, count, text, project.lastKinds);
      const intent = scanIntent(text);
      if (intent === "scan")
        return count !== null ? scanWith(botId, count, text, project.lastKinds) : askCount(botId);
      // "find clients with 50 staff": a scan, or a change to the profile?
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
