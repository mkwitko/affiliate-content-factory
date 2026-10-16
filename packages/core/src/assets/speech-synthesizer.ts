import type { WorkspaceId } from "@money-maker/contracts";

/**
 * A replaceable text-to-speech port: turns a slide's spoken sentence into a WAV clip with
 * word-level timing. Core defines only the shape; packages/providers holds the Kokoro
 * implementation so core never depends on an HTTP client or a model runtime.
 */
export type SpokenWord = Readonly<{ text: string; startMs: number; endMs: number }>;

export type SpeechSynthesisInput = Readonly<{
  text: string;
  voiceId: string;
  language: string;
  /** Present when the caller may reuse a stored clip (stage cache); absent bypasses the cache. */
  workspaceId?: WorkspaceId;
}>;

export type SpeechSynthesisOutput = Readonly<{
  bytes: Uint8Array;
  mimeType: "audio/wav";
  durationMs: number;
  words: readonly SpokenWord[];
  /** True when the clip came from the stage cache instead of the synthesizer. */
  cached?: boolean;
}>;

export interface SpeechSynthesizer {
  synthesize(input: SpeechSynthesisInput): Promise<SpeechSynthesisOutput>;
}
