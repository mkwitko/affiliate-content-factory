import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { validateSlideSpec } from "@money-maker/core/creatives/templates";
import { describe, expect, it } from "vitest";
import { PREVIEW_CASES, runPostPreview, specFor } from "./post-preview.js";

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
};
const png = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height, 120);
  for (let y = 0; y < height; y += 1) raw[y * stride] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

describe("post-preview", () => {
  it("has preview copy that passes the slide limits", () => {
    expect(Object.keys(PREVIEW_CASES)).toHaveLength(18);
    for (const item of Object.values(PREVIEW_CASES))
      expect(validateSlideSpec(specFor(item))).toEqual({ ok: true });
    for (const item of Object.values(PREVIEW_CASES))
      expect(specFor(item).body).not.toContain("#publi");
  });
  // Renders every slide of three niches with measured ink: about 15 s on a dev box, more on a
  // loaded VM running the deploy gate.
  it("renders found scenes, skips missing ones and survives a failed logo fetch", {
    timeout: 90_000,
  }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "post-preview-"));
    await mkdir(join(dir, "images"));
    await writeFile(join(dir, "images", "casa_feed.png"), png(64, 80));
    await writeFile(join(dir, "images", "tech_story.png"), png(64, 112));
    await writeFile(join(dir, "images", "casa_problem.png"), png(64, 80));
    await writeFile(
      join(dir, "images", "casa_problem.subjects.json"),
      JSON.stringify([
        { kind: "face", box: [400, 350, 600, 500] },
        { kind: "person", box: [300, 300, 700, 1000] },
      ]),
    );
    await mkdir(join(dir, "images-2x"));
    await writeFile(join(dir, "images-2x", "casa_feed.png"), png(128, 160));
    await writeFile(
      join(dir, "images", "casa_feed.subjects.json"),
      JSON.stringify([{ kind: "face", box: [300, 100, 700, 300] }]),
    );
    await writeFile(join(dir, "images", "tech_story.subjects.json"), "[{");
    const lines: string[] = [];
    const result = await runPostPreview({
      inDir: dir,
      outDir: join(dir, "posts"),
      doFetch: async () => new Response("no", { status: 404 }),
      log: (l) => lines.push(l),
    });
    expect((await readdir(join(dir, "posts"))).sort()).toEqual([
      "casa_feed.jpg",
      "casa_feed.reel.jpg",
      "casa_problem.jpg",
      "casa_problem.reel.jpg",
      "tech_story.jpg",
      "tech_story.reel.jpg",
    ]);
    expect(result.missing).toEqual([
      "casa_story",
      "beleza_feed",
      "beleza_story",
      "tech_feed",
      "casa_problem2",
      "casa_discovery",
      "casa_result",
      "beleza_problem",
      "beleza_problem2",
      "beleza_discovery",
      "beleza_result",
      "tech_problem",
      "tech_problem2",
      "tech_discovery",
      "tech_result",
    ]);
    expect(lines.some((l) => l.includes("speech bubble"))).toBe(false);
    expect(lines).toContain("casa_feed: using images-2x");
    expect(lines).not.toContain("tech_story: using images-2x");
    expect(lines).toContain("casa_feed: keeping text off 1 subject box(es)");
    expect(lines).toContain("tech_story: subjects.json invalid, default layout");
    expect(lines.some((l) => l.includes("without logo"))).toBe(true);
    expect(lines.some((l) => l.includes("skipped beleza_feed"))).toBe(true);
  });
});
