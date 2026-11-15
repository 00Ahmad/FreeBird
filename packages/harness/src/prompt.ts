import type { Bot, Thread } from "@mrog/shared";

interface PromptContext {
  thread: Thread;
  /** Other bots in a group chat. */
  teammates: Bot[];
  now: Date;
  /** Saved memory notes (Phase 4). */
  memory?: string[];
  /** Extra sections, e.g. workspace folder or tool guidance. */
  extra?: string[];
}

/**
 * The local date and hour, not the exact time: the prompt then stays the same all hour, so the model (and a cloud
 * provider's prompt cache) can reuse the work it did for the conversation so far instead of re-reading it all.
 */
function currentTime(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const day = now.toLocaleDateString("en-US", { weekday: "long" });
  const hour = now.getHours();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `Today is ${day}, ${date}. The local time is between ${pad(hour)}:00 and ${pad((hour + 1) % 24)}:00 (${zone}).`;
}

export function buildSystemPrompt(bot: Bot, context: PromptContext): string {
  const sections = [
    `You are ${bot.name}${bot.label ? `, ${bot.label}` : ""}: an AI teammate the user messages in the FreeBird app.`,
    // A bot-to-bot thread (a helper's or a Coding Bot role's) has no user to answer a question, and a question there
    // ends the hand-off without the work: choose and say what was assumed instead.
    context.thread.pair
      ? "Be direct and useful. Use Markdown when it helps. If something is unclear, make a sensible choice and say what you assumed."
      : "Be direct and useful. Use Markdown when it helps. Ask a short question when a request is ambiguous.",
    currentTime(context.now),
  ];
  if (bot.instructions.trim())
    sections.push(`Your standing instructions from the user:\n${bot.instructions.trim()}`);
  // A bot-to-bot thread is a group only in how it's stored: no user is in it, and what the bot was asked to do comes
  // from the hand-over prompt instead.
  if (context.thread.kind === "group" && !context.thread.pair) {
    const names = context.teammates.map((mate) => mate.name).join(", ") || "no other bots";
    sections.push(
      `This is a group chat with the user and these bots: ${names}. Messages from other bots are prefixed with their name in brackets. Answer only for yourself, keep it short, and don't repeat what a teammate already said.`,
    );
  }
  if (context.memory?.length) {
    sections.push(
      `Things you remember about the user and your work:\n${context.memory.map((note) => `- ${note}`).join("\n")}`,
    );
  }
  sections.push(...(context.extra ?? []));
  return sections.join("\n\n");
}
