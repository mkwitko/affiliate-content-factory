import { describe, expect, it } from "vitest";
import { createAudiocppClient } from "./audiocpp-client.js";

describe("audio.cpp client", () => {
  it("posts speech as JSON with the model options and returns the wav bytes", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const client = createAudiocppClient({
      baseUrl: "http://127.0.0.1:18200",
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, body: JSON.parse(init.body as string) });
        return new Response(new Uint8Array([82, 73, 70, 70]));
      }) as typeof fetch,
    });
    const out = await client.speech({
      model: "kokoro",
      text: "oi",
      options: { voice: "pf_dora", language: "pt-br" },
    });
    expect([...out.wav]).toEqual([82, 73, 70, 70]);
    expect(seen[0]).toEqual({
      url: "http://127.0.0.1:18200/v1/audio/speech",
      body: { model: "kokoro", input: "oi", voice: "pf_dora", language: "pt-br" },
    });
  });

  it("uploads the clip for transcription and refuses a reply without text", async () => {
    const client = createAudiocppClient({
      baseUrl: "http://127.0.0.1:18200",
      fetch: (async (_url: string, init: RequestInit) => {
        const form = init.body as FormData;
        return new Response(
          JSON.stringify(form.get("language") === "pt" ? { text: "olá" } : { nope: 1 }),
        );
      }) as typeof fetch,
    });
    expect(
      (await client.transcribe({ model: "asr", wav: new Uint8Array(4), language: "pt" })).text,
    ).toBe("olá");
    await expect(client.transcribe({ model: "asr", wav: new Uint8Array(4) })).rejects.toThrow(
      "audiocpp_transcribe_invalid",
    );
  });

  it("refuses a non-loopback server", () => {
    expect(() => createAudiocppClient({ baseUrl: "http://192.168.0.2:8080" })).toThrow();
  });
});
