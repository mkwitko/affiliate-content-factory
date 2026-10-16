import { describe, expect, it } from "vitest";
import type { ReelTimeline } from "@money-maker/core/assets/reel-timeline";
import { resolveCaptionTheme } from "@money-maker/core/brand/caption-style";
import { assTime, buildCaptionAss, escapeAssText } from "./reel-captions.js";

describe("assTime", () => {
  it("formats milliseconds as H:MM:SS.cc", () => {
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(61_234)).toBe("0:01:01.23");
  });
});

describe("escapeAssText", () => {
  it("escapes ASS override braces, backslashes, and newlines", () => {
    expect(escapeAssText("a{b}\\c\nd")).toBe("a(b)/c d");
  });
});

describe("buildCaptionAss", () => {
  it("groups one slide's words 3 at a time and highlights the active word", () => {
    const timeline: ReelTimeline = {
      crossfadeSec: 0.8,
      totalSec: 2,
      slides: [
        {
          index: 0,
          startSec: 0,
          durationSec: 2,
          voiceStartSec: 0,
          words: [
            { text: "Olá", startMs: 0, endMs: 300 },
            { text: "mundo", startMs: 300, endMs: 700 },
            { text: "hoje", startMs: 700, endMs: 1200 },
            { text: "tudo", startMs: 1200, endMs: 1600 },
          ],
        },
      ],
    };

    const ass = buildCaptionAss(timeline);
    expect(ass).not.toBeNull();
    const text = ass as string;

    expect(text).toContain("[Script Info]");
    expect(text).toContain("PlayResY: 1920");
    expect(text).toContain("Style: Default,Inter,64,");

    const dialogueLines = text.split("\n").filter((line) => line.startsWith("Dialogue:"));
    expect(dialogueLines).toHaveLength(4);
    expect(dialogueLines[0]).toBe(
      "Dialogue: 0,0:00:00.00,0:00:00.30,Default,,0,0,0,,{\\c&H00FFFF&\\fscx115\\fscy115\\t(0,150,\\fscx100\\fscy100)}Olá{\\c&HFFFFFF&\\fscx100\\fscy100} mundo hoje",
    );
    // The fourth word starts a new group (groupSize 3) and stands alone.
    expect(dialogueLines[3]).toContain(
      "{\\c&H00FFFF&\\fscx115\\fscy115\\t(0,150,\\fscx100\\fscy100)}tudo",
    );
    expect(dialogueLines[3]).not.toContain("hoje");
  });

  it("keeps consecutive Dialogue lines contiguous even when word timings have gaps", () => {
    const timeline: ReelTimeline = {
      crossfadeSec: 0.8,
      totalSec: 2,
      slides: [
        {
          index: 0,
          startSec: 0,
          durationSec: 2,
          voiceStartSec: 0,
          words: [
            { text: "Olá", startMs: 0, endMs: 250 },
            { text: "mundo", startMs: 300, endMs: 650 },
            { text: "hoje", startMs: 700, endMs: 1150 },
            { text: "tudo", startMs: 1200, endMs: 1550 },
          ],
        },
      ],
    };

    const text = buildCaptionAss(timeline) as string;
    const dialogueLines = text.split("\n").filter((line) => line.startsWith("Dialogue:"));
    expect(dialogueLines).toHaveLength(4);

    const parseTimes = (line: string) => {
      const [, start, end] = line.split(",");
      return { start, end };
    };
    for (let i = 0; i < dialogueLines.length - 1; i++) {
      const current = parseTimes(dialogueLines[i] as string);
      const next = parseTimes(dialogueLines[i + 1] as string);
      expect(current.end).toBe(next.start);
    }
  });

  it("never groups words across slides", () => {
    const timeline: ReelTimeline = {
      crossfadeSec: 0.8,
      totalSec: 4,
      slides: [
        {
          index: 0,
          startSec: 0,
          durationSec: 2,
          voiceStartSec: 0,
          words: [
            { text: "primeiro", startMs: 0, endMs: 300 },
            { text: "slide", startMs: 300, endMs: 600 },
          ],
        },
        {
          index: 1,
          startSec: 2,
          durationSec: 2,
          voiceStartSec: 2,
          words: [
            { text: "segundo", startMs: 2000, endMs: 2300 },
            { text: "slide", startMs: 2300, endMs: 2600 },
          ],
        },
      ],
    };

    const text = buildCaptionAss(timeline) as string;
    const dialogueLines = text.split("\n").filter((line) => line.startsWith("Dialogue:"));
    expect(dialogueLines).toHaveLength(4);
    for (const line of dialogueLines) {
      expect(line.includes("primeiro") && line.includes("segundo")).toBe(false);
    }
  });

  it("returns null when the timeline carries no words at all", () => {
    const timeline: ReelTimeline = {
      crossfadeSec: 0.8,
      totalSec: 2,
      slides: [{ index: 0, startSec: 0, durationSec: 2, voiceStartSec: 0, words: [] }],
    };
    expect(buildCaptionAss(timeline)).toBeNull();
  });
});

describe("boxed captions", () => {
  const timeline: ReelTimeline = {
    crossfadeSec: 0.8,
    totalSec: 1,
    slides: [
      {
        index: 0,
        startSec: 0,
        durationSec: 1,
        voiceStartSec: 0,
        words: [{ text: "milk", startMs: 0, endMs: 500 }],
      },
    ],
  };
  const style = (ass: string | null) => ass?.split("\n").find((line) => line.startsWith("Style:"));

  it("draws an opaque dark box behind captions for light explainer scenes", () => {
    const line = style(buildCaptionAss(timeline, { boxed: true, marginV: 670 }));
    expect(line).toBe(
      "Style: Default,Inter,64,&H00FFFFFF,&H000000FF,&H30161616,&H30161616,-1,0,0,0,100,100,0,0,3,14,0,2,80,80,670,1",
    );
  });

  it("keeps the outlined style by default", () => {
    expect(style(buildCaptionAss(timeline))).toContain(",1,4,2,2,80,80,576,1");
  });
});

describe("legacy output is frozen (INV-B5)", () => {
  const timeline: ReelTimeline = {
    crossfadeSec: 0.8,
    totalSec: 4,
    slides: [
      {
        index: 0,
        startSec: 0,
        durationSec: 2,
        voiceStartSec: 0,
        words: ["Olá", "mundo", "hoje", "tudo"].map((text, i) => ({
          text,
          startMs: i * 400,
          endMs: i * 400 + 350,
        })),
      },
    ],
  };
  it.each([
    ["default", undefined],
    ["owned clip", { fontSize: 56, marginV: 300, groupSize: 3 }],
    ["boxed", { marginV: 560, groupSize: 2, boxed: true }],
  ] as const)("%s", (_name, style) => {
    expect(buildCaptionAss(timeline, style)).toMatchSnapshot();
  });
});

describe("themed captions", () => {
  const timeline: ReelTimeline = {
    crossfadeSec: 0.8,
    totalSec: 4,
    slides: [
      {
        index: 0,
        startSec: 0,
        durationSec: 2,
        voiceStartSec: 0,
        words: ["Olá", "mundo", "hoje", "tudo"].map((text, i) => ({
          text,
          startMs: i * 400,
          endMs: i * 400 + 350,
        })),
      },
    ],
  };
  const themed = (niche?: Record<string, unknown>, canvas: "portrait" | "landscape" = "portrait") =>
    buildCaptionAss(timeline, {
      theme: resolveCaptionTheme({ canvas, ...(niche ? { niche: { context: niche } } : {}) }),
    }) as string;
  const styleLine = (ass: string) => ass.split("\n").find((l) => l.startsWith("Style:"));

  it("default word_pop theme is byte-identical to the legacy output (INV-B5)", () => {
    // Handlers only resolve a theme when the niche sets captionTheme, so unconfigured niches take the
    // legacy path untouched. The one deliberate difference of a themed portrait caption is the
    // INV-B3 right rail (marginR 160), neutralised here to compare everything else.
    const theme = resolveCaptionTheme({ canvas: "portrait" });
    expect(buildCaptionAss(timeline, { theme: { ...theme, marginR: 80 } })).toBe(
      buildCaptionAss(timeline),
    );
  });

  it("boxed preset draws an opaque box so per-word runs do not leave darker marks", () => {
    const ass = themed({ captionTheme: { preset: "boxed" } });
    expect(styleLine(ass)).toContain("&H00161616,&H00161616,-1,0,0,0,100,100,0,0,3,14,0,2");
  });

  it("karaoke emits one \\kf line per group with the highlight as primary", () => {
    const ass = themed({ captionTheme: { preset: "karaoke" } });
    const dialogue = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogue).toHaveLength(2);
    expect(dialogue[0]).toContain("{\\kf40}Olá {\\kf40}mundo {\\kf");
    expect(styleLine(ass)).toContain("&H0000FFFF,&H00FFFFFF");
  });

  it("uppercases, aligns the lower third left and drops highlights for documentary", () => {
    const ass = themed({ captionTheme: { preset: "documentary", uppercase: true } });
    expect(ass).toContain("OLÁ");
    expect(styleLine(ass)).toMatch(/,1,80,160,420,1$/);
    expect(ass).not.toContain("\\c&H");
  });

  it("uses the landscape play resolution", () => {
    expect(themed(undefined, "landscape")).toContain("PlayResX: 1920");
  });
});
