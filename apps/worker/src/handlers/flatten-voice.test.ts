import { describe, expect, it } from "vitest";
import { flattenVoice } from "./render-long-form.js";

const bytes = (n: number) => new Uint8Array([n]);

describe("flattenVoice", () => {
  it("keeps one clip per scene when no scene has dialogue", () => {
    const out = flattenVoice([bytes(1), bytes(2)], [200, 5_000], [undefined, undefined]);
    expect(out).toEqual({ voiceClips: [bytes(1), bytes(2)], voiceStartMs: [200, 5_000] });
  });

  it("places a dialogue scene's line clips at the scene voice start plus their offsets", () => {
    const out = flattenVoice(
      [bytes(1), bytes(9)],
      [200, 5_000],
      [
        undefined,
        {
          clips: [bytes(3), bytes(4)],
          startsMs: [0, 980],
          edits: [{ trimMs: 700, duckFromMs: 500 }, {}],
        },
      ],
    );
    expect(out.voiceClips).toEqual([bytes(1), bytes(3), bytes(4)]);
    expect(out.voiceStartMs).toEqual([200, 5_000, 5_980]);
    expect(out.voiceEdits).toEqual([undefined, { trimMs: 700, duckFromMs: 500 }, {}]);
  });
});
