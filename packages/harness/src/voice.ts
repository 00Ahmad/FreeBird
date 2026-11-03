import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { presetFor, providerKeyName, VoiceSettings } from "@mrog/shared";

import { fail, parse } from "./http";
import type { Services } from "./services";

const KEY = "voice";
const DEFAULT: VoiceSettings = { sttProvider: null, sttModel: null };
const MAX_AUDIO = 25 * 1024 * 1024;

const TranscribeInput = z.object({
  audio: z.string().max(Math.ceil((MAX_AUDIO * 4) / 3)),
  mediaType: z.string().regex(/^audio\/[\w.+-]+(;.*)?$/),
});

/** Speech-to-text through any OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq, a local whisper server…). */
export function registerVoiceRoutes(
  app: FastifyInstance,
  services: Services,
  fetchImpl: typeof fetch = fetch,
) {
  const settings = (): VoiceSettings => {
    const parsed = VoiceSettings.safeParse(services.store.settings.get(KEY) ?? DEFAULT);
    return parsed.success ? parsed.data : DEFAULT;
  };

  app.get("/api/voice", async () => ({ settings: settings() }));

  app.put("/api/voice", async (request, reply) => {
    const body = parse(VoiceSettings, request.body, reply);
    if (!body) return reply;
    services.store.settings.set(KEY, body);
    return { settings: body };
  });

  app.post("/api/voice/transcribe", async (request, reply) => {
    const body = parse(TranscribeInput, request.body, reply);
    if (!body) return reply;
    const { sttProvider, sttModel } = settings();
    const config = services.providers.configs().find((candidate) => candidate.id === sttProvider);
    const preset = config ? presetFor(config.preset) : undefined;
    if (!config || !sttModel || preset?.kind !== "openai") {
      return fail(reply, 409, "not_configured", "Set up speech-to-text in Settings → Voice first.");
    }
    const base = (config.baseUrl || preset.baseUrl).replace(/\/+$/, "");
    const key = services.vault.has(providerKeyName(config.id))
      ? services.vault.get(providerKeyName(config.id))
      : null;
    const mediaType = body.mediaType.split(";")[0]!;
    const extension = mediaType.split("/")[1]?.replace("x-", "") ?? "webm";
    const form = new FormData();
    form.append(
      "file",
      new Blob([Buffer.from(body.audio, "base64")], { type: mediaType }),
      `speech.${extension}`,
    );
    form.append("model", sttModel);
    try {
      const res = await fetchImpl(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: key
          ? preset.keyHeader
            ? { [preset.keyHeader]: key }
            : { authorization: `Bearer ${key}` }
          : {},
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      if (!res.ok) return fail(reply, 502, "transcription_failed", `${config.label}: ${text.slice(0, 300)}`);
      return { text: (JSON.parse(text) as { text?: string }).text?.trim() ?? "" };
    } catch (error) {
      return fail(reply, 502, "transcription_failed", (error as Error).message);
    }
  });
}
