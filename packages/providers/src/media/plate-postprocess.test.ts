import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  COMPOSITING_HYPOTHESIS,
  DEFAULT_COMPOSITING,
  oklab,
  platePostProcessPlan,
} from "@money-maker/core/explainer/compositing";
import { DEFAULT_SCENE_PALETTE } from "@money-maker/core/explainer/explainer-context";
import { measureFocalContrast, postProcessPlate } from "./plate-postprocess.js";

/** A saturated, busy plate: vivid stripes over the whole height. */
const busyPlate = async (size = 768) =>
  new Uint8Array(
    await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${Array.from(
          { length: 24 },
          (_, i) =>
            `<rect y="${(i * size) / 24}" width="${size}" height="${size / 24}" fill="${i % 2 ? "#00c000" : "#101060"}"/>`,
        ).join("")}</svg>`,
      ),
    )
      .png()
      .toBuffer(),
  );

const bandStd = async (bytes: Uint8Array, top: number, bottom: number) => {
  const { data, info } = await sharp(Buffer.from(bytes))
    .resize(96, 96, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const values: number[] = [];
  for (let y = Math.ceil(top * 96); y < Math.floor(bottom * 96); y += 1)
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * 3;
      values.push(oklab(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0)[0]);
    }
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
};

describe("postProcessPlate", () => {
  it("caps chroma, compresses the halo band, pulls far values and records every step", async () => {
    const plate = await busyPlate();
    const plan = platePostProcessPlan(COMPOSITING_HYPOTHESIS, DEFAULT_SCENE_PALETTE);
    const out = await postProcessPlate(plate, plan);
    expect(out.mimeType).toBe("image/jpeg");
    expect(out.record.saturationScale).toBeLessThan(1);
    expect(out.record.haloContrastScale).toBeLessThan(1);
    const center = (plan.haloBand.top + plan.haloBand.bottom) / 2;
    const after = await bandStd(out.bytes, center - 0.08, center + 0.08);
    expect(after).toBeLessThan(out.record.haloStdBefore * 0.6);
    const before = await sharp(Buffer.from(plate)).stats();
    const pulled = await sharp(Buffer.from(out.bytes)).stats();
    // Pull toward the light surface raises the dark stripes.
    expect(pulled.channels[2]?.mean ?? 0).toBeGreaterThan(before.channels[2]?.mean ?? 0);
  });

  it("leaves a plate alone when the default profile asks for nothing", async () => {
    const plate = await busyPlate();
    const plan = platePostProcessPlan(
      { ...DEFAULT_COMPOSITING, backgroundChromaCap: 2, actorHaloVarianceMax: 1 },
      DEFAULT_SCENE_PALETTE,
    );
    const out = await postProcessPlate(plate, plan);
    expect(out.record).toMatchObject({ saturationScale: 1, haloContrastScale: 1, farValuePull: 0 });
  });

  it("skips plates under 512 px", async () => {
    const out = await postProcessPlate(
      await busyPlate(256),
      platePostProcessPlan(COMPOSITING_HYPOTHESIS, DEFAULT_SCENE_PALETTE),
    );
    expect(out.record.skipped).toBe("too_small");
  });
});

describe("measureFocalContrast", () => {
  const frame = async (figure: string | null, bg: string) =>
    new Uint8Array(
      await sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="${bg}"/>${figure ? `<rect x="80" y="60" width="40" height="80" fill="${figure}"/>` : ""}</svg>`,
        ),
      )
        .png()
        .toBuffer(),
    );

  it("is high for a dark figure on a light ground and near zero for a matching ground", async () => {
    const strong = await measureFocalContrast(
      await frame("#161616", "#F6F1E7"),
      await frame(null, "#F6F1E7"),
      8,
    );
    expect(strong.contrast).toBeGreaterThan(0.7);
    expect(strong.maskPx).toBe(40 * 80);
    const weak = await measureFocalContrast(
      await frame("#505050", "#404040"),
      await frame(null, "#404040"),
      8,
    );
    expect(weak.contrast).toBeLessThan(0.1);
  });
});
