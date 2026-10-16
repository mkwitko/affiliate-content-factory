import { describe, expect, it } from "vitest";
import { BOTTOM_STYLES, HAIR_STYLES, TOP_STYLES } from "../explainer-context.js";
import {
  EXPRESSIONS,
  POSES,
  poseAngles,
  renderStickman,
  renderStickmanFrame,
  sketchSeed,
} from "./stick-v1.js";

const palette = { line: "#1b1b1b", fill: "#ffffff", accent: "#ff5a36" };

describe("stick-v1 rig", () => {
  it("renders every pose and expression deterministically", () => {
    for (const pose of POSES)
      for (const expression of EXPRESSIONS) {
        const a = renderStickman({ pose, expression, palette, x: 540, baselineY: 1180 });
        const b = renderStickman({ pose, expression, palette, x: 540, baselineY: 1180 });
        expect(a).toBe(b);
        expect(a.startsWith("<g")).toBe(true);
        expect(a).toContain(`stroke="${palette.line}"`);
        expect(a).not.toContain("NaN");
      }
  });

  it("gives each pose a distinct drawing", () => {
    const drawings = new Set(
      POSES.map((pose) =>
        renderStickman({ pose, expression: "neutral", palette, x: 540, baselineY: 1180 }),
      ),
    );
    expect(drawings.size).toBe(POSES.length);
  });

  it("gives each expression a distinct face", () => {
    const faces = new Set(
      EXPRESSIONS.map((expression) =>
        renderStickman({ pose: "neutral", expression, palette, x: 540, baselineY: 1180 }),
      ),
    );
    expect(faces.size).toBe(EXPRESSIONS.length);
  });

  it("mirrors when facing left", () => {
    const right = renderStickman({
      pose: "pointing",
      expression: "neutral",
      palette,
      x: 540,
      baselineY: 1180,
    });
    const left = renderStickman({
      pose: "pointing",
      expression: "neutral",
      palette,
      x: 540,
      baselineY: 1180,
      facing: "left",
    });
    expect(left).not.toBe(right);
    expect(left).toContain("scale(-1,1)");
  });

  it("draws the accessory in the accent colour", () => {
    const svg = renderStickman({
      pose: "neutral",
      expression: "neutral",
      palette,
      x: 540,
      baselineY: 1180,
      accessory: "cap",
    });
    expect(svg).toContain(`fill="${palette.accent}"`);
  });

  it("matches the snapshot for the hero pose", () => {
    expect(
      renderStickman({
        pose: "holding_phone",
        expression: "surprised",
        palette,
        x: 540,
        baselineY: 1180,
      }),
    ).toMatchSnapshot();
  });

  it("turns the face and glasses toward a gaze without moving the head", () => {
    const look = (gaze?: { x: number; y: number }) =>
      renderStickmanFrame({
        angles: poseAngles("neutral"),
        expression: "neutral",
        palette,
        x: 540,
        baselineY: 1180,
        accessory: "glasses",
        gaze,
      });
    const faceX = (svg: string) =>
      Number(svg.match(/r="58"[^>]*\/><g transform="translate\((-?[\d.]+),/)?.[1]);
    const lensX = (svg: string) =>
      Number(svg.match(/<circle cx="(-?[\d.]+)" cy="-?[\d.]+" r="16"/)?.[1]);
    const headAt = (svg: string) =>
      svg.match(/<circle cx="(-?[\d.]+)" cy="(-?[\d.]+)" r="58"/)?.[0];
    const ahead = look({ x: 1, y: 0 });
    expect(faceX(ahead) - faceX(look())).toBeCloseTo(12, 1);
    expect(lensX(ahead) - lensX(look())).toBeCloseTo(12, 1);
    expect(headAt(ahead)).toBe(headAt(look()));
  });

  const wardrobe = {
    hair: { style: "long", colour: "#6b3e26" },
    top: { style: "hoodie", colour: "#2f6fdb" },
    bottoms: { style: "pants", colour: "#333333" },
  } as const;
  const frameOf = (over: Partial<Parameters<typeof renderStickmanFrame>[0]> = {}) =>
    renderStickmanFrame({
      angles: poseAngles("walking"),
      expression: "happy",
      palette,
      x: 540,
      baselineY: 1180,
      extremities: true,
      ...over,
    });

  it("dresses a character in rig order: long hair behind the head, the front sleeve over it", () => {
    const dressed = frameOf({ wardrobe });
    for (const colour of ["#6b3e26", "#2f6fdb", "#333333"])
      expect(dressed).toContain(`fill="${colour}"`);
    expect(dressed).not.toContain("NaN");
    const head = dressed.indexOf('r="58"');
    expect(dressed.indexOf('fill="#6b3e26"')).toBeLessThan(head);
    expect(dressed.lastIndexOf('fill="#2f6fdb"')).toBeGreaterThan(head);
    expect(frameOf({ wardrobe: undefined })).toBe(frameOf());
  });

  it("draws every wardrobe piece in every pose with a big head, facing either way, without NaN", () => {
    for (const pose of POSES)
      for (const [i, style] of HAIR_STYLES.entries())
        for (const facing of ["left", "right"] as const) {
          const svg = frameOf({
            angles: poseAngles(pose),
            facing,
            accessory: "headphones",
            wardrobe: {
              hair: { style, colour: "#111111" },
              top: { style: TOP_STYLES[i % TOP_STYLES.length] ?? "tshirt", colour: "#222222" },
              bottoms: {
                style: BOTTOM_STYLES[i % BOTTOM_STYLES.length] ?? "pants",
                colour: "#333333",
              },
              head: "big",
            },
          });
          expect(svg).not.toContain("NaN");
          for (const colour of ["#111111", "#222222", "#333333"]) expect(svg).toContain(colour);
        }
  });

  it("scales the face and head accessories with a big head and leaves the tie at the neck", () => {
    for (const accessory of ["cap", "glasses", "headphones"] as const) {
      const big = frameOf({ angles: poseAngles("neutral"), accessory, wardrobe: { head: "big" } });
      expect(big).toContain('r="72.5"');
      expect(big).toMatch(/\) scale\(1\.25\)">/);
      expect(big).toMatch(/scale\(1\.25\) translate\(/);
      expect(big).not.toContain("NaN");
    }
    const tie = frameOf({
      angles: poseAngles("neutral"),
      accessory: "tie",
      wardrobe: { head: "big" },
    });
    expect(tie).not.toMatch(/scale\(1\.25\) translate\(/);
  });

  it("draws seeded hand-drawn lines: stable per seed, unlike the clean rig and other seeds", () => {
    const draw = (sketch?: { seed: number }) =>
      frameOf({ angles: poseAngles("pointing"), wardrobe: { head: "big" }, sketch });
    const alexLines = draw({ seed: sketchSeed("alex") });
    expect(draw({ seed: sketchSeed("alex") })).toBe(alexLines);
    expect(alexLines).not.toBe(draw());
    expect(alexLines).not.toBe(draw({ seed: sketchSeed("bia") }));
    expect(alexLines).not.toContain("<polyline");
    expect(alexLines).not.toContain("NaN");
    expect(alexLines).toContain('stroke-opacity="0.45"');
  });
});
