import { describe, expect, it } from "vitest";
import { composeSceneSvg } from "./compose-scene.js";
import type { ExplainerCharacter } from "./explainer-context.js";
import { CAPTION_BAND, FRAME } from "./layout.js";
import type { SceneSpec } from "./scene-spec.js";

const alex: ExplainerCharacter = {
  key: "alex",
  name: "Alex",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#222222", fill: "#ffffff", accent: "#ff5a36" },
  accessory: "glasses",
};
const context = {
  characters: [alex],
  palette: {
    surface: "#f6f1e7",
    muted: "#d9d2c5",
    accent: "#ff5a36",
    text: "#111111",
    line: "#111111",
  },
};
const scene: SceneSpec = {
  index: 1,
  fromChar: 0,
  toChar: 10,
  purpose: "hook",
  background: "bank",
  actors: [
    { characterKey: "alex", pose: "holding_phone", expression: "surprised", position: "center" },
  ],
  props: [{ type: "money_stack", position: "right", label: "R$ 100" }],
  overlays: [{ text: "YOUR MONEY?", emphasis: true, position: "top" }],
  camera: { shot: "medium", movement: "slow_zoom_in" },
  transition: "hard_cut",
  captionMode: "word",
};

describe("composeSceneSvg", () => {
  it("produces a full-frame svg with every layer", () => {
    const svg = composeSceneSvg(scene, context);
    expect(
      svg.startsWith(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME.width}" height="${FRAME.height}"`,
      ),
    ).toBe(true);
    expect(svg).toContain('data-background="bank"');
    expect(svg).toContain("YOUR MONEY?");
    expect(svg).toContain("R$ 100");
    expect(svg).toContain(`stroke="${alex.palette.line}"`);
  });

  it("keeps every overlay above the caption band", () => {
    for (const position of ["top", "middle"] as const) {
      const svg = composeSceneSvg({ ...scene, overlays: [{ text: "TEXT", position }] }, context);
      const y = Number(/<text data-overlay="1"[^>]* y="(\d+)"/.exec(svg)?.[1]);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(CAPTION_BAND.top);
    }
  });

  it("keeps prop labels above the caption band", () => {
    for (const shot of ["wide", "medium", "close"] as const) {
      const svg = composeSceneSvg({ ...scene, camera: { shot, movement: "none" } }, context);
      const match =
        /data-prop="money_stack" transform="translate\([\d.]+,([\d.]+)\) scale\(([\d.]+)\)"/.exec(
          svg,
        );
      const labelY = Number(match?.[1]) + 130 * Number(match?.[2]);
      expect(labelY).toBeLessThan(CAPTION_BAND.top);
    }
  });

  it("is deterministic", () => {
    expect(composeSceneSvg(scene, context)).toBe(composeSceneSvg(scene, context));
  });

  it("renders a diagram-only scene", () => {
    const svg = composeSceneSvg(
      {
        ...scene,
        actors: [],
        props: [],
        overlays: [],
        diagram: {
          kind: "flow",
          nodes: [
            { id: "a", label: "You" },
            { id: "b", label: "Bank" },
          ],
          edges: [{ from: "a", to: "b" }],
        },
      },
      context,
    );
    expect(svg).toContain("marker-end");
    expect(svg).not.toContain('<circle cx="0"');
  });

  it("caps character size so close shots stay inside the frame", () => {
    const svg = composeSceneSvg(
      {
        ...scene,
        camera: { shot: "close", movement: "none" },
        actors: [
          {
            characterKey: "alex",
            pose: "celebrating",
            expression: "excited",
            position: "left",
            scale: 1.4,
          },
        ],
      },
      context,
    );
    expect(svg).toContain("scale(1.3)");
  });

  it("shrinks characters when a diagram shares the scene", () => {
    const withDiagram = composeSceneSvg(
      { ...scene, diagram: { kind: "percent", value: 50, label: "half", claimRef: 0 } },
      context,
    );
    expect(withDiagram).toContain("scale(0.55)");
  });

  it("fails loudly when a character is missing from the cast", () => {
    expect(() => composeSceneSvg(scene, { ...context, characters: [] })).toThrow(
      "scene_character_missing:1",
    );
  });
});
