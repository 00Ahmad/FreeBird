/** What can be done from an error in the chat. */
export type ErrorAction = "retry" | "switch-model" | "settings-model" | "settings-providers";

export interface PlainError {
  /** One sentence a person can act on. */
  title: string;
  /** What to try, when there is something. */
  hint: string | null;
  actions: ErrorAction[];
  /** The original text, kept for whoever wants it: shown behind a "Details" toggle, never dropped. */
  detail: string | null;
}

interface Input {
  code: string;
  message: string;
  /**
   * Whether answering again is on offer: this is the bot's latest reply, and trying again can't repeat something
   * it already did. The caller decides; this only removes the button.
   */
  retryable: boolean;
}

/** Text that is for developers: a stack frame, an error class name, a socket error code. */
const TECHNICAL =
  /\bat\s+\S+\s+\(.*:\d+:\d+\)|\b(?:TypeError|RangeError|SyntaxError|ReferenceError|AggregateError)\b|\b(?:ECONN\w+|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|UND_ERR\w*)\b|fetch failed|socket hang up|stack trace|\{\s*"error"/i;

const CANT_REACH =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network|couldn't reach|could not connect/i;
const RATE_LIMIT =
  /\b429\b|rate.?limit|too many requests|quota|insufficient[_ ]credit|out of credit|billing/i;
const SERVER_SIDE = /\b5\d\d\b|bad gateway|service unavailable|internal server error|overloaded/i;
const TOO_LONG =
  /context length|context window|too many tokens|maximum context|prompt is too long|input is too long/i;

const trimmed = (text: string) => text.replace(/\s+/g, " ").trim();

/** Turns an error from a reply into words a person can use, with the buttons that fit. */
export function plainError({ code, message, retryable }: Input): PlainError {
  const detail = trimmed(message) || null;
  const make = (title: string, hint: string | null, actions: ErrorAction[]): PlainError => ({
    title,
    hint,
    // Trying again is only worth offering where it can help, and only where it is safe to.
    actions: actions.filter((action) => retryable || action !== "retry"),
    detail,
  });

  // The model's context is full: a different problem from "it didn't accept the request", with a different way out.
  if (TOO_LONG.test(message))
    return make(
      "This conversation is longer than the model can take.",
      "Start a new chat, or switch to a model that takes more text.",
      ["switch-model", "settings-model"],
    );

  switch (code) {
    case "provider_down":
      return make(
        "I couldn't reach the model.",
        "Check that it's running (for Ollama, open it), then try again.",
        ["retry", "settings-model"],
      );
    case "model_missing":
      return make("That model isn't available.", "Pick another one, or download it in Settings.", [
        "switch-model",
        "settings-model",
      ]);
    case "invalid_key":
      return make(
        "The provider didn't accept the key.",
        "Check or replace the key in Settings → Models & Providers.",
        ["settings-providers"],
      );
    case "quota":
      return make(
        "The provider is limiting requests, or the account is out of credit.",
        "Wait a little and try again, or switch to another model.",
        ["retry", "switch-model", "settings-providers"],
      );
    case "oom":
      return make(
        "The model ran out of memory.",
        "Try a smaller model, or a smaller context size in Settings → Local model.",
        ["switch-model", "settings-model"],
      );
    case "timeout":
      return make("The model took too long to answer.", "Try again, or switch to a faster model.", [
        "retry",
        "switch-model",
      ]);
    case "stalled":
      return make(
        "The model went quiet, so I stopped waiting.",
        "It may have been stuck. Try again, or switch to a model that responds faster.",
        ["retry", "switch-model"],
      );
    case "bad_output":
      return make(
        "The model wrote something I couldn't read.",
        "Trying again often works. A larger model is more reliable with tools.",
        ["retry", "switch-model"],
      );
    case "needs_vision":
      return make(
        "This Visual Bot's model can't see pictures.",
        "Visual Bots work from screenshots. Switch to a model that can see, such as qwen3.5:9b.",
        ["switch-model", "settings-model"],
      );
    case "bad_request":
      return make("The model didn't accept the request.", "Another model, or a new chat, may do better.", [
        "switch-model",
      ]);
    case "interrupted":
      return make(
        "The app closed while this was running.",
        "It may or may not have finished. Check before asking again, so it isn't done twice.",
        [],
      );
    case "unreadable":
      return make("This message could not be read.", null, []);
    default:
      break;
  }

  // Not a code we know (or an unexpected one): say what kind of trouble it looks like.
  if (CANT_REACH.test(message))
    return make(
      "I couldn't connect.",
      "Check your connection and that the model's server is running, then try again.",
      ["retry", "settings-model"],
    );
  if (RATE_LIMIT.test(message))
    return make(
      "The provider is limiting requests, or the account is out of credit.",
      "Wait a little and try again, or switch to another model.",
      ["retry", "switch-model"],
    );
  if (SERVER_SIDE.test(message))
    return make(
      "The provider had a problem on its side.",
      "Try again in a moment, or switch to another model.",
      ["retry", "switch-model"],
    );
  // Plain words from the app itself (a short sentence) are already fit to show.
  if (detail && detail.length <= 160 && !TECHNICAL.test(message) && /[a-z]/i.test(detail))
    return { title: detail, hint: null, actions: retryable ? ["retry"] : [], detail: null };
  return make("Something went wrong.", "Try again. If it keeps happening, the details may help.", ["retry"]);
}
