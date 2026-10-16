import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  judgeFidelity,
  PROVISIONAL_FIDELITY_THRESHOLDS,
} from "@money-maker/core/creatives/product-fidelity";
import { ALTERATIONS, alterPhoto, type Alteration } from "./fidelity-alterations.js";
import { measureProductFidelity } from "./sharp-fidelity-measurer.js";

/**
 * No real product photo is committed (AGENTS.md: no third-party media in Git), so this is a
 * synthetic listing photo: white studio background, red kettle body, dark logo plate with light
 * stripes centred where detail_blanked patches, a yellow button and a handle.
 */
const listingPhoto = async (): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp(
      Buffer.from(
        `<svg width="480" height="480" xmlns="http://www.w3.org/2000/svg">
          <rect width="480" height="480" fill="#ffffff"/>
          <rect x="120" y="110" width="220" height="280" rx="36" fill="#c0392b"/>
          <path d="M340 170 q70 0 70 80 q0 80 -70 80" stroke="#2c3e50" stroke-width="22" fill="none"/>
          <rect x="160" y="190" width="160" height="80" rx="8" fill="#1f2a36"/>
          <rect x="175" y="205" width="130" height="10" fill="#f5f5f5"/>
          <rect x="175" y="225" width="90" height="10" fill="#f5f5f5"/>
          <rect x="175" y="245" width="110" height="8" fill="#f5f5f5"/>
          <circle cx="230" cy="330" r="18" fill="#f1c40f"/>
          <rect x="150" y="80" width="160" height="34" rx="10" fill="#2c3e50"/>
        </svg>`,
      ),
    )
      .png()
      .toBuffer(),
  );
/** Product mask: every pixel that is not studio white. */
const whiteMask = async (photo: Uint8Array): Promise<Uint8Array> => {
  const { data, info } = await sharp(photo)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = Buffer.alloc(info.width * info.height);
  for (let pixel = 0; pixel < mask.length; pixel += 1)
    mask[pixel] =
      Math.min(data[pixel * 3] ?? 0, data[pixel * 3 + 1] ?? 0, data[pixel * 3 + 2] ?? 0) > 240
        ? 0
        : 255;
  return new Uint8Array(
    await sharp(mask, { raw: { width: info.width, height: info.height, channels: 1 } })
      .png()
      .toBuffer(),
  );
};
const verdictFor = async (kind: Alteration) => {
  const photo = await listingPhoto();
  const metrics = await measureProductFidelity({
    original: photo,
    rendered: await alterPhoto(photo, kind),
    region: { x: 0, y: 0, w: 480, h: 480 },
    mask: await whiteMask(photo),
  });
  return judgeFidelity(metrics, PROVISIONAL_FIDELITY_THRESHOLDS);
};

describe("alterPhoto with the provisional fidelity thresholds", () => {
  it("labels two good and three altered kinds", () => {
    expect(Object.entries(ALTERATIONS)).toEqual([
      ["legit_jpeg", "good"],
      ["legit_resample", "good"],
      ["colour_shift", "altered"],
      ["detail_blanked", "altered"],
      ["silhouette_crop", "altered"],
    ]);
  });

  it("passes legitimate compression and resampling", async () => {
    expect((await verdictFor("legit_jpeg")).verdict).toBe("pass");
    expect((await verdictFor("legit_resample")).verdict).toBe("pass");
  });

  it("blocks a colour change and a cut silhouette", async () => {
    expect(await verdictFor("colour_shift")).toMatchObject({ verdict: "block" });
    expect((await verdictFor("colour_shift")).reasons).toContain("deltaE_block");
    expect((await verdictFor("silhouette_crop")).reasons).toContain("maskIou_block");
  });

  it("never passes a blanked logo plate", async () => {
    const report = await verdictFor("detail_blanked");
    expect(report.verdict).not.toBe("pass");
    expect(report.reasons).toContain("msSsim_warn");
  });
});
