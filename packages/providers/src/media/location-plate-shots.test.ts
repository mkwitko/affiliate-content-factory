import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCENE_PALETTE,
  type ExplainerCharacter,
} from "@money-maker/core/explainer/explainer-context";
import { OFFICE_LOCATION } from "@money-maker/core/explainer/fixtures/cast/location-fixture";
import { readLocations } from "@money-maker/core/explainer/locations";
import { composeMotionFrame } from "@money-maker/core/explainer/motion/frame";
import { planMotion } from "@money-maker/core/explainer/motion/plan";
import type { SceneSpec } from "@money-maker/core/explainer/scene-spec";

/**
 * v2 slice 24 acceptance: one location plate serves six distinct-looking shots (zones, seeds,
 * lighting), and every shot's plate covers the frame edge to edge.
 */
const cast: ExplainerCharacter[] = [
  {
    key: "alex",
    name: "Alex",
    role: "main",
    rigId: "stick-v1",
    rigVersion: 1,
    palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
  },
];
// A plate with a left-to-right gradient and blocks, so different crops look different.
const plateSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1216" height="1344"><defs><linearGradient id="g"><stop offset="0" stop-color="#6b8fb3"/><stop offset="1" stop-color="#d9a066"/></linearGradient></defs><rect width="1216" height="1344" fill="url(#g)"/>${Array.from({ length: 8 }, (_, i) => `<rect x="${i * 150 + 20}" y="${300 + (i % 3) * 200}" width="90" height="${200 + i * 30}" fill="#2f4858"/>`).join("")}</svg>`;

const shots: readonly Partial<SceneSpec>[] = [
  { zoneId: "desk" },
  { zoneId: "window", camera: { shot: "close", movement: "none" } },
  { zoneId: "door", camera: { shot: "wide", movement: "none" } },
  { zoneId: "overview", camera: { shot: "establishing", movement: "none" } },
  { zoneId: "desk", lighting: "night" },
  { zoneId: "window", lighting: "indoor_warm", camera: { shot: "close", movement: "none" } },
];

describe("one location plate, six shots", () => {
  it("renders six distinct frames whose plate fills the frame", async () => {
    const plate = await sharp(Buffer.from(plateSvg)).png().toBuffer();
    const art = new Map([
      ["plate-office", { href: `data:image/png;base64,${plate.toString("base64")}` }],
    ]);
    const frames: Buffer[] = [];
    for (const [i, over] of shots.entries()) {
      const plan = planMotion({
        scenes: [
          {
            index: 1,
            fromChar: 0,
            toChar: 3,
            purpose: "hook",
            background: "office",
            backgroundAssetId: "plate-office",
            locationId: "office_a",
            actors: [],
            props: [{ type: "laptop", position: "center" }],
            overlays: [],
            camera: { shot: "medium", movement: "none" },
            transition: "hard_cut",
            captionMode: "none",
            ...over,
          },
        ],
        timings: [
          { startMs: 0, endMs: 1_000, voiceStartMs: 0, voiceEndMs: 800, text: "a b", words: [] },
        ],
        characters: cast,
        palette: DEFAULT_SCENE_PALETTE,
        captionWords: 3,
        durationMs: 1_000,
        backgroundArt: art,
        locations: readLocations([OFFICE_LOCATION]),
        variationSeed: `episode-${i}`,
      });
      frames.push(
        await sharp(Buffer.from(composeMotionFrame(plan, 600)), { density: 72 })
          .resize(108, 192)
          .removeAlpha()
          .raw()
          .toBuffer(),
      );
    }
    const surface = [0xf6, 0xf1, 0xe7];
    for (const frame of frames)
      for (const [x, y] of [
        [0, 0],
        [107, 0],
        [0, 191],
        [107, 191],
      ] as const) {
        const i = (y * 108 + x) * 3;
        const d =
          Math.abs((frame[i] ?? 0) - (surface[0] ?? 0)) +
          Math.abs((frame[i + 1] ?? 0) - (surface[1] ?? 0));
        expect(d).toBeGreaterThan(20);
      }
    const meanDiff = (a: Buffer, b: Buffer) => {
      let sum = 0;
      for (let i = 0; i < a.length; i += 1) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
      return sum / a.length;
    };
    for (let i = 0; i < frames.length; i += 1)
      for (let j = i + 1; j < frames.length; j += 1)
        expect(meanDiff(frames[i] as Buffer, frames[j] as Buffer)).toBeGreaterThan(2);
  }, 60_000);
});
