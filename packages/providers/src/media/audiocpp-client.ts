import { localBaseUrl } from "../llm/llama-server-frame-reviewer.js";

/**
 * audio.cpp server (OpenAI-shaped /v1/audio/speech and /v1/audio/transcriptions). Loopback
 * only: the server has no authentication. Used by the speech arena; production TTS stays Kokoro.
 */
export type AudiocppClient = Readonly<{
  speech(input: {
    model: string;
    text: string;
    options?: Readonly<Record<string, string | number>>;
  }): Promise<Readonly<{ wav: Uint8Array; latencyMs: number }>>;
  transcribe(input: {
    model: string;
    wav: Uint8Array;
    language?: string;
  }): Promise<Readonly<{ text: string; latencyMs: number }>>;
}>;

export const createAudiocppClient = (options: {
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): AudiocppClient => {
  const origin = localBaseUrl(options.baseUrl);
  const doFetch = options.fetch ?? fetch;
  const timeout = () => AbortSignal.timeout(options.timeoutMs ?? 600_000);
  return {
    async speech({ model, text, options: extra }) {
      const started = performance.now();
      const response = await doFetch(`${origin}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: text, ...extra }),
        signal: timeout(),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        throw Object.assign(new Error(`audiocpp_speech_http_${response.status}`), {
          cause: detail,
        });
      }
      const wav = new Uint8Array(await response.arrayBuffer());
      return { wav, latencyMs: Math.round(performance.now() - started) };
    },
    async transcribe({ model, wav, language }) {
      const form = new FormData();
      form.set("model", model);
      if (language) form.set("language", language);
      form.set("file", new Blob([Uint8Array.from(wav)], { type: "audio/wav" }), "clip.wav");
      const started = performance.now();
      const response = await doFetch(`${origin}/v1/audio/transcriptions`, {
        method: "POST",
        body: form,
        signal: timeout(),
      });
      if (!response.ok) throw new Error(`audiocpp_transcribe_http_${response.status}`);
      const body = (await response.json()) as { text?: unknown };
      if (typeof body.text !== "string") throw new Error("audiocpp_transcribe_invalid");
      return { text: body.text, latencyMs: Math.round(performance.now() - started) };
    },
  };
};
