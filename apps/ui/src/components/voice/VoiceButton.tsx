import { Loader2, Mic, Square, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { IconButton } from "@mrog/ui-kit";

import { api, ApiRequestError } from "../../lib/api";
import { isMac } from "../../lib/harness";
import { layerOpen } from "../../lib/layers";
import { useUi } from "../../state";

const toBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** Dictation: record, transcribe with the configured speech-to-text provider, insert. Cmd/Ctrl+D. */
export function VoiceButton({ onTranscript }: { onTranscript(text: string): void }) {
  const [state, setState] = useState<"idle" | "starting" | "recording" | "transcribing">("idle");
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  // Set while the microphone is being asked for, so a quick second Cmd/Ctrl+D can't start another recorder.
  const starting = useRef(false);
  const mounted = useRef(true);
  // The transcript arrives seconds later: insert it with the latest callback, not the one from the start.
  const transcript = useRef(onTranscript);
  useEffect(() => {
    transcript.current = onTranscript;
  });
  const openSettings = useUi((ui) => ui.openSettings);

  // Leaving the chat mid-dictation turns the microphone off and drops the recording.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (recorder.current?.state !== "inactive") recorder.current?.stop();
      recorder.current?.stream.getTracks().forEach((track) => track.stop());
      recorder.current = null;
    };
  }, []);

  const stop = () => recorder.current?.stop();

  const start = async () => {
    if (starting.current) return;
    starting.current = true;
    setError(null);
    setState("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (!mounted.current) return;
      setError("No microphone access. Allow it in your system settings.");
      setState("idle");
      return;
    } finally {
      starting.current = false;
    }
    if (!mounted.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const chunks: Blob[] = [];
    const media = new MediaRecorder(stream);
    recorder.current = media;
    media.addEventListener("dataavailable", (event) => chunks.push(event.data));
    media.addEventListener("stop", async () => {
      stream.getTracks().forEach((track) => track.stop());
      if (recorder.current === media) recorder.current = null;
      if (!mounted.current) return;
      setState("transcribing");
      try {
        const blob = new Blob(chunks, { type: media.mimeType || "audio/webm" });
        const { text } = await api<{ text: string }>("/voice/transcribe", {
          method: "POST",
          body: { audio: await toBase64(blob), mediaType: blob.type },
        });
        if (text && mounted.current) transcript.current(text);
      } catch (caught) {
        if (!mounted.current) return;
        const notSet = caught instanceof ApiRequestError && caught.status === 409;
        setError(notSet ? "Set up dictation in Settings → Voice." : (caught as Error).message);
        if (notSet) openSettings("voice");
      } finally {
        if (mounted.current) setState("idle");
      }
    });
    media.start();
    setState("recording");
  };

  const toggle = () => (state === "recording" ? stop() : state === "idle" ? void start() : undefined);
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      // Over Settings or another dialog, the shortcut isn't for the chat behind it.
      if (event.key.toLowerCase() !== "d" || layerOpen()) return;
      event.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const mod = isMac() ? "⌘" : "Ctrl+";
  return (
    <>
      <IconButton
        label={state === "recording" ? "Stop dictation" : `Start voice input (${mod}D)`}
        onClick={toggle}
        disabled={state === "starting" || state === "transcribing"}
        className={state === "recording" ? "bg-danger/15 text-danger" : ""}
      >
        {state === "recording" ? (
          <Square size={14} className="fill-current" />
        ) : state === "starting" || state === "transcribing" ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Mic size={16} />
        )}
      </IconButton>
      {error && <span className="truncate text-xs text-danger">{error}</span>}
    </>
  );
}

/** Reads a reply aloud with the computer's built-in voices. */
export function ReadAloud({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);
  if (typeof speechSynthesis === "undefined" || !text) return null;
  const button =
    "inline-flex size-6 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink";
  return (
    <button
      type="button"
      className={button}
      aria-label={speaking ? "Stop reading" : "Read aloud"}
      title={speaking ? "Stop reading" : "Read aloud"}
      onClick={() => {
        speechSynthesis.cancel();
        if (speaking) return setSpeaking(false);
        const utterance = new SpeechSynthesisUtterance(text.replace(/[*_`#>|]/g, ""));
        utterance.addEventListener("end", () => setSpeaking(false));
        utterance.addEventListener("error", () => setSpeaking(false));
        setSpeaking(true);
        speechSynthesis.speak(utterance);
      }}
    >
      {speaking ? <VolumeX size={13} /> : <Volume2 size={13} />}
    </button>
  );
}
