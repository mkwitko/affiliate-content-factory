import { createHash } from "node:crypto";
import { DEFAULT_BRAND_KIT } from "@money-maker/core/brand/brand-kit";
import {
  judgeFidelity,
  PROVISIONAL_FIDELITY_THRESHOLDS,
} from "@money-maker/core/creatives/product-fidelity";
import { templateFor } from "@money-maker/core/creatives/templates";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createSharpCreativeRenderer } from "./sharp-creative-renderer.js";
import { measureProductFidelity } from "./sharp-fidelity-measurer.js";

const product = async (): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp(
      Buffer.from(
        '<svg width="600" height="800" xmlns="http://www.w3.org/2000/svg"><rect x="50" y="50" width="500" height="700" rx="40" fill="#333"/></svg>',
      ),
    )
      .png()
      .toBuffer(),
  );
const spec = {
  index: 1,
  total: 6,
  template: "hero",
  headline: "Seu notebook na altura certa",
  body: "Dobra, cabe na mochila e segura até 15 polegadas",
  badge: "4,8 ★ · 1.200 avaliações",
  claims: [],
} as const;

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("sharp creative renderer", () => {
  it("renders feed and story deterministically at the canvas size", {
    timeout: 30_000,
  }, async () => {
    const renderer = createSharpCreativeRenderer();
    for (const canvas of ["feed", "story"] as const) {
      const out = await renderer.render({
        canvas,
        template: templateFor("hero", canvas),
        spec,
        brand: DEFAULT_BRAND_KIT,
        product: { png: await product(), mode: "cutout" },
        background: { procedural: true },
      });
      expect([out.width, out.height]).toEqual(canvas === "feed" ? [1080, 1350] : [1080, 1920]);
      // Deterministic for the same input. A byte snapshot would pin the installed Inter build
      // (the dev box and Ubuntu's fonts-inter rasterize differently), not the renderer.
      const again = await renderer.render({
        canvas,
        template: templateFor("hero", canvas),
        spec,
        brand: DEFAULT_BRAND_KIT,
        product: { png: await product(), mode: "cutout" },
        background: { procedural: true },
      });
      expect(sha(again.bytes)).toBe(sha(out.bytes));
    }
  });
  it("preserves product color and frames untouched source photos", {
    timeout: 30_000,
  }, async () => {
    const renderer = createSharpCreativeRenderer();
    const red = new Uint8Array(
      await sharp(
        Buffer.from(
          '<svg width="400" height="400" xmlns="http://www.w3.org/2000/svg"><rect x="20" y="20" width="360" height="360" fill="#d0342c"/></svg>',
        ),
      )
        .png()
        .toBuffer(),
    );
    const out = await renderer.render({
      canvas: "feed",
      template: templateFor("hero", "feed"),
      spec,
      brand: DEFAULT_BRAND_KIT,
      product: { png: red, mode: "cutout" },
      background: { procedural: true },
    });
    const { data } = await sharp(out.bytes)
      .extract({ left: 540, top: 700, width: 4, height: 4 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(Math.abs((data[0] ?? 0) - 0xd0)).toBeLessThan(6);
    expect(Math.abs((data[1] ?? 0) - 0x34)).toBeLessThan(6);
    expect(Math.abs((data[2] ?? 0) - 0x2c)).toBeLessThan(6);
    const framed = await renderer.render({
      canvas: "feed",
      template: templateFor("hero", "feed"),
      spec,
      brand: DEFAULT_BRAND_KIT,
      product: { png: await product(), mode: "framed" },
      background: { procedural: true },
    });
    const framedAgain = await renderer.render({
      canvas: "feed",
      template: templateFor("hero", "feed"),
      spec,
      brand: DEFAULT_BRAND_KIT,
      product: { png: await product(), mode: "framed" },
      background: { procedural: true },
    });
    expect(sha(framedAgain.bytes)).toBe(sha(framed.bytes));
  });
  it("reports the composited product layer and region, which pass fidelity QA", async () => {
    const renderer = createSharpCreativeRenderer();
    for (const mode of ["cutout", "framed"] as const) {
      const out = await renderer.render({
        canvas: "feed",
        template: templateFor("hero", "feed"),
        spec,
        brand: DEFAULT_BRAND_KIT,
        product: { png: await product(), mode },
        background: { procedural: true },
      });
      if (!out.product) throw new Error("product layer missing");
      const layer = await sharp(out.product.layer).metadata();
      // The fixture's trimmed aspect differs from its box, so its top-left pixel is letterbox,
      // which must be transparent (sharp's default contain background is opaque black).
      const corner = await sharp(out.product.layer)
        .extract({ left: 0, top: 0, width: 1, height: 1 })
        .raw()
        .toBuffer();
      expect(corner[3]).toBe(0);
      expect([out.product.region.w, out.product.region.h]).toEqual([layer.width, layer.height]);
      expect(out.product.region.x + out.product.region.w).toBeLessThanOrEqual(out.width);
      expect(out.product.region.y + out.product.region.h).toBeLessThanOrEqual(out.height);
      const metrics = await measureProductFidelity({
        original: out.product.layer,
        rendered: out.bytes,
        region: out.product.region,
      });
      expect(judgeFidelity(metrics, PROVISIONAL_FIDELITY_THRESHOLDS).verdict).toBe("pass");
    }
  });
  it("drops body after headline shrink attempts and fails an unfit headline", async () => {
    const renderer = createSharpCreativeRenderer();
    const long = { ...spec, headline: "Uma frase muito longa para caber em duas linhas mesmo" };
    const out = await renderer.render({
      canvas: "feed",
      template: templateFor("hero", "feed"),
      spec: long,
      brand: DEFAULT_BRAND_KIT,
      product: { png: await product(), mode: "cutout" },
      background: { procedural: true },
    });
    expect(out.layout.bodyDropped).toBe(true);
    await expect(
      renderer.render({
        canvas: "feed",
        template: templateFor("hero", "feed"),
        spec: { ...spec, headline: "x".repeat(60) },
        brand: DEFAULT_BRAND_KIT,
        product: { png: await product(), mode: "cutout" },
        background: { procedural: true },
      }),
    ).rejects.toThrow("layout_failed:headline_unfit");
  });
  it("renders text over a full generated scene without a product layer", {
    timeout: 30_000,
  }, async () => {
    const renderer = createSharpCreativeRenderer();
    const scene = new Uint8Array(
      await sharp({
        create: { width: 512, height: 640, channels: 3, background: "#808080" },
      })
        .png()
        .toBuffer(),
    );
    const out = await renderer.render({
      canvas: "feed",
      template: templateFor("hero", "feed"),
      spec,
      brand: DEFAULT_BRAND_KIT,
      product: { inScene: true },
      background: { png: scene },
    });
    expect([out.width, out.height]).toEqual([1080, 1350]);
    expect(out.product).toBeUndefined();
    const meta = await sharp(out.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 1080, 1350]);
    const { channels } = await sharp(out.bytes)
      .extract({ left: 86, top: 135, width: 908, height: 216 })
      .stats();
    expect(channels[0]?.stdev ?? 0).toBeGreaterThan(5);
    // The overlay alone: transparent where the scene shows, opaque where text is drawn.
    const layer = await sharp(out.overlay as Uint8Array)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([layer.info.width, layer.info.height, layer.info.channels]).toEqual([1080, 1350, 4]);
    const alphas = layer.data.filter((_, i) => i % 4 === 3);
    expect(alphas.some((a) => a === 0)).toBe(true);
    expect(alphas.some((a) => a === 255)).toBe(true);
    await expect(
      renderer.render({
        canvas: "feed",
        template: templateFor("hero", "feed"),
        spec,
        brand: DEFAULT_BRAND_KIT,
        product: { inScene: true },
        background: { procedural: true },
      }),
    ).rejects.toThrow("layout_failed:in_scene_background_required");
    const placed = await renderer.render({
      canvas: "feed",
      template: templateFor("hero", "feed"),
      spec,
      brand: DEFAULT_BRAND_KIT,
      product: { inScene: true },
      background: { png: scene },
      subjects: [{ kind: "face", box: [300, 100, 700, 300] }],
    });
    expect(placed.layout.subjectLayout?.collisions).toEqual([]);
    expect(placed.layout.boxes?.headline).toBeDefined();
  });
  it("in-scene story: a feed scene keeps its full width, framed on a blurred copy", {
    timeout: 30_000,
  }, async () => {
    const scene = new Uint8Array(
      await sharp({ create: { width: 512, height: 640, channels: 3, background: "#ff0000" } })
        .png()
        .toBuffer(),
    );
    const out = await createSharpCreativeRenderer().render({
      canvas: "story",
      template: templateFor("hero", "story"),
      spec: { ...spec, total: 1 },
      brand: DEFAULT_BRAND_KIT,
      product: { inScene: true },
      background: { png: scene },
    });
    const at = async (x: number, y: number) =>
      (
        await sharp(out.bytes).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer()
      )[0] ?? 0;
    // Right edge, clear of text: the scene itself inside its frame, the darkened copy above it.
    expect(await at(1070, 300)).toBeGreaterThan(235);
    expect(await at(1070, 100)).toBeLessThan(220);
  });
  it("in-scene: two-tone headline, circular logo with no opaque bars, separate tag", {
    timeout: 30_000,
  }, async () => {
    const renderer = createSharpCreativeRenderer();
    const scene = new Uint8Array(
      await sharp({ create: { width: 512, height: 640, channels: 3, background: "#f4f4f4" } })
        .png()
        .toBuffer(),
    );
    const wide = new Uint8Array(
      await sharp({ create: { width: 400, height: 100, channels: 4, background: "#ff0000" } })
        .png()
        .toBuffer(),
    );
    const brand = {
      ...DEFAULT_BRAND_KIT,
      palette: { ...DEFAULT_BRAND_KIT.palette, primary: "#0000ff", accent: "#00ff00" },
    };
    const out = await renderer.render({
      canvas: "feed",
      template: templateFor("hero", "feed"),
      spec: { ...spec, total: 1, headline: "Dark part\nAccent part", disclosure: "#publi" },
      brand,
      product: { inScene: true },
      background: { png: scene },
      logo: { png: wide },
    });
    // Measured typography (brief 13): every text element reports its real ink.
    expect(out.layout.ink?.headline).toBeDefined();
    const inkHead = out.layout.ink?.headline as { x: number; y: number; w: number; h: number };
    const box = out.layout.boxes?.headline as { x: number; y: number; w: number; h: number };
    // The halo stroke and descenders reach a few pixels past the padded box (under the 2% QA slack).
    expect(inkHead.x).toBeGreaterThanOrEqual(box.x - 24);
    expect(inkHead.x + inkHead.w).toBeLessThanOrEqual(box.x + box.w + 24);
    expect(inkHead.y).toBeGreaterThanOrEqual(box.y - 24);
    expect(inkHead.y + inkHead.h).toBeLessThanOrEqual(box.y + box.h + 24);
    const raw = await sharp(out.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number): number[] => {
      const o = (y * raw.info.width + x) * 3;
      return [raw.data[o] ?? 0, raw.data[o + 1] ?? 0, raw.data[o + 2] ?? 0];
    };
    // Just outside the logo circle (65..205 px, y 65..205): scene colour, not black.
    for (const [x, y] of [
      [40, 135],
      [135, 40],
      [230, 135],
    ] as const)
      expect(Math.min(...px(x, y))).toBeGreaterThan(200);
    // Both headline tones are drawn, dark in the first line and accent in the second.
    const hasTone = async (top: number, want: (p: number[]) => boolean): Promise<boolean> => {
      const { data } = await sharp(out.bytes)
        .extract({ left: 65, top, width: 900, height: 80 })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      for (let i = 0; i < data.length; i += 3)
        if (want([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0])) return true;
      return false;
    };
    expect(await hasTone(250, (p) => p[2]! > 200 && p[0]! < 60 && p[1]! < 60)).toBe(true);
    expect(await hasTone(330, (p) => p[1]! > 200 && p[0]! < 60 && p[2]! < 60)).toBe(true);
  });
});
