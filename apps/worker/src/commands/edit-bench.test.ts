import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { EDIT_BENCH_CORPUS } from "@money-maker/core/creatives/fixtures/edit-bench-corpus";
import type { ImageEditor } from "@money-maker/core/creatives/scene-bank";
import { describe, expect, it, vi } from "vitest";
import { loadReference, runEditBench, summarizeEditBench } from "./edit-bench.js";

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
};
/** Solid-colour RGB PNG; `shade` tells images apart. */
const png = async (width: number, height: number, shade = 0): Promise<Uint8Array> => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height, shade);
  for (let y = 0; y < height; y += 1) raw[y * stride] = 0;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
};

const two = EDIT_BENCH_CORPUS.slice(0, 2);

describe("corpus", () => {
  it("has 18 cases, character sheet first, story 9:16 and the rest feed 4:5, no text asked for", () => {
    expect(EDIT_BENCH_CORPUS).toHaveLength(18);
    for (const c of EDIT_BENCH_CORPUS) {
      expect([c.width, c.height]).toEqual(c.id.endsWith("story") ? [768, 1344] : [768, 960]);
      expect(c.prompt).toContain("first reference image");
      expect(c.prompt).toContain("second reference image");
      expect(c.prompt).toContain("No text");
      expect(c.prompt).toContain(
        c.id.endsWith("story") ? "top 25% and bottom 25% calm" : "no faces in the upper third",
      );
    }
  });
});

describe("loadReference", () => {
  it("downloads once, follows redirects, caches and rejects non-images", async () => {
    const dir = await mkdtemp(join(tmpdir(), "edit-bench-"));
    const id = "be5cd8e0-1d3d-46a1-8e32-455c2c1774f8";
    const body = await png(64, 64);
    const doFetch = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(Buffer.from(body)),
    );
    await loadReference("https://x.test/a/", id, dir, doFetch);
    await loadReference("https://x.test/a/", id, dir, doFetch);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(doFetch.mock.calls[0]?.[0]).toBe(`https://x.test/a/${id}`);
    expect(await readdir(dir)).toEqual([`${id}.bin`]);
    await expect(
      loadReference(
        "https://x.test/a/",
        "4e630393-95b1-4482-85e1-9fcbf739f916",
        dir,
        async () => new Response("nope"),
      ),
    ).rejects.toThrow("edit_bench_reference_invalid");
  });
});

describe("runEditBench", () => {
  it("passes references in order, records rows and a failure row", async () => {
    const char = await png(64, 64, 10);
    const product = await png(64, 64, 200);
    const out = await png(768, 960, 90);
    const calls: (readonly Uint8Array[])[] = [];
    let n = 0;
    const editor: ImageEditor = {
      edit: async (_p, refs) => {
        calls.push(refs as readonly Uint8Array[]);
        if (++n === 2) throw new Error("sdcpp_timeout");
        return { bytes: out, mimeType: "image/png", width: 768, height: 960, neurons: 0 };
      },
    };
    const rows = await runEditBench({
      model: "m",
      steps: 4,
      cases: two,
      editor,
      loadReference: async (id) => (id === two[0]?.references[0] ? char : product),
    });
    expect(calls[0]).toEqual([char, product]);
    expect(rows[0]).toMatchObject({
      caseId: "casa_feed",
      decodeValid: true,
      dimensionsValid: true,
      error: null,
    });
    expect(rows[1]).toMatchObject({
      caseId: "casa_story",
      error: "sdcpp_timeout",
      humanScore: null,
    });
    const summary = summarizeEditBench(rows);
    expect(summary).toMatchObject({ rows: 2, failures: 1, promoted: false });
    expect(summary.gate).toMatchObject({ maxSec: 600, noCrash: false, humanReviewPending: true });
  });

  it("stops after three consecutive failures", async () => {
    const editor: ImageEditor = {
      edit: async () => {
        throw new Error("sdcpp_http_500");
      },
    };
    const rows = await runEditBench({
      model: "m",
      steps: 4,
      cases: EDIT_BENCH_CORPUS,
      editor,
      loadReference: async () => new Uint8Array(),
    });
    expect(rows).toHaveLength(3);
  });
});
