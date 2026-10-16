import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCommandImageSegmenter,
  maskStats,
  parseSegmenterCommand,
} from "./command-image-segmenter.js";

describe("parseSegmenterCommand", () => {
  it("accepts an explicit licensed rembg model with both placeholders", () =>
    expect(parseSegmenterCommand(" rembg i -m isnet-general-use -om {input} {output} ")).toEqual([
      "rembg",
      "i",
      "-m",
      "isnet-general-use",
      "-om",
      "{input}",
      "{output}",
    ]));
  it("rejects a command without both placeholders", () => {
    expect(() => parseSegmenterCommand("rembg i -m u2netp -om in.png {output}")).toThrow(
      "segmenter_cmd_invalid",
    );
    expect(() => parseSegmenterCommand("")).toThrow("segmenter_cmd_invalid");
  });
  it("rejects rembg's default BRIA model, explicit or implied", () => {
    expect(() => parseSegmenterCommand("rembg i -m bria-rmbg -om {input} {output}")).toThrow(
      "segmenter_model_not_licensed",
    );
    expect(() => parseSegmenterCommand("/usr/local/bin/rembg i -om {input} {output}")).toThrow(
      "segmenter_model_required",
    );
  });
});

describe("maskStats", () => {
  it("measures bbox and decisive-pixel confidence", () => {
    const values = new Uint8Array(16);
    values[5] = 255;
    values[6] = 255;
    values[10] = 128;
    expect(maskStats(values, 4, 4)).toEqual({
      bbox: { x: 1, y: 1, w: 2, h: 2 },
      confidence: 15 / 16,
    });
  });
  it("reports an empty mask with zero confidence", () =>
    expect(maskStats(new Uint8Array(4), 2, 2)).toEqual({
      bbox: { x: 0, y: 0, w: 0, h: 0 },
      confidence: 0,
    }));
});

describe("createCommandImageSegmenter", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "segmenter-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A stand-in for rembg: copies a prepared mask to {output}, or exits 3. */
  const fakeCli = async (mode: "copy" | "fail") => {
    const mask = join(dir, "fixed-mask.png");
    await writeFile(
      mask,
      await sharp(
        Buffer.from(
          '<svg width="40" height="40" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" fill="#000"/><rect x="10" y="10" width="20" height="20" fill="#fff"/></svg>',
        ),
      )
        .png()
        .toBuffer(),
    );
    const script = join(dir, "fake-rembg.mjs");
    await writeFile(
      script,
      mode === "copy"
        ? `import { copyFileSync } from "node:fs"; copyFileSync(${JSON.stringify(mask)}, process.argv[3]);`
        : "process.exit(3);",
    );
    return `${process.execPath} ${script} {input} {output}`;
  };
  const photo = async () =>
    new Uint8Array(
      await sharp({ create: { width: 40, height: 40, channels: 3, background: "#888888" } })
        .jpeg()
        .toBuffer(),
    );

  it("returns the CLI mask with its bbox and confidence and cleans its temp dir", async () => {
    const tempRoot = join(dir, "work");
    await mkdir(tempRoot);
    const segmenter = createCommandImageSegmenter({ command: await fakeCli("copy"), tempRoot });
    const result = await segmenter.segment({ bytes: await photo(), mimeType: "image/jpeg" });
    expect(result.bbox).toEqual({ x: 10, y: 10, w: 20, h: 20 });
    expect(result.confidence).toBeGreaterThan(0.9);
    expect((await sharp(result.maskPng).metadata()).width).toBe(40);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("rejects when the CLI fails, so the caller frames the photo", async () => {
    const segmenter = createCommandImageSegmenter({ command: await fakeCli("fail") });
    await expect(
      segmenter.segment({ bytes: await photo(), mimeType: "image/jpeg" }),
    ).rejects.toThrow("process_failed:3");
  });

  it("fails at construction for an invalid command", () =>
    expect(() => createCommandImageSegmenter({ command: "rembg i {input} {output}" })).toThrow(
      "segmenter_model_required",
    ));
});
