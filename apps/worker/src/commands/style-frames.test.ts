// apps/worker/src/commands/style-frames.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSITING_HYPOTHESIS } from "@money-maker/core/explainer/compositing";
import { SAM } from "@money-maker/core/explainer/fixtures/cast/cost-curious-cast";
import { STYLE_CANDIDATES } from "@money-maker/core/explainer/fixtures/style-frames/candidates";
import { STYLE_FRAME_SHOTS } from "@money-maker/core/explainer/fixtures/style-frames/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import {
  blindOrder,
  fixtureBackgrounds,
  generatePlates,
  renderActingSwap,
  renderSamPlates,
  renderStyleFrames,
  SAM_PLATE_CAST,
  SAM_PLATE_SHOTS,
  type StyleFrameDeps,
} from "./style-frames.js";

const png = (tag: string) => new TextEncoder().encode(`png:${tag}`);

const fakeDeps = (plates: Set<string> = new Set()): StyleFrameDeps & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    rasterize: async (svg) => {
      calls.push("rasterize");
      return png(svg.length.toString());
    },
    thumbnail: async (bytes) => png(`thumb:${bytes.byteLength}`),
    sheet: async (tiles, tile) => png(`sheet:${tiles.map((t) => t.label).join("")}:${tile.width}`),
    gradePlate: async (plate, grade) => {
      calls.push(`grade:${grade}`);
      return { ...plate, provenance: { grade } };
    },
    voiceClip: async () => png("voice"),
    renderMotion: async (plan) => {
      calls.push(`motion:${plan.durationMs}`);
      return png("mp4");
    },
    plates: {
      load: async (candidateId, background) =>
        plates.has(`${candidateId}/${background}`)
          ? { bytes: png("plate"), mimeType: "image/png", provenance: { model: "test" } }
          : null,
    },
    gitHead: async () => "abc123",
    ffmpegVersion: async () => "ffmpeg version test",
    now: () => new Date("2026-09-30T20:00:00Z"),
  };
};

describe("renderStyleFrames", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("writes every frame, thumbnail, motion test, blind sheet, key and manifest", async () => {
    dir = await mkdtemp(join(tmpdir(), "style-frames-"));
    const deps = fakeDeps(new Set(["expressive-ink-cutout-painted/store"]));
    const result = await renderStyleFrames(deps, { outDir: dir, blindSeed: 7 });
    const stills = STYLE_FRAME_SHOTS.filter((shot) => shot.id !== "00-motion-test");
    const expected = [
      ...STYLE_CANDIDATES.flatMap((candidate) => [
        ...stills.flatMap((shot) => [
          `${candidate.id}/frames/${shot.id}.png`,
          `${candidate.id}/thumbs/${shot.id}.png`,
        ]),
        `${candidate.id}/00-motion-test.mp4`,
      ]),
      ...stills.flatMap((shot) => [
        `review/blind/${shot.id}.png`,
        `review/blind/${shot.id}-160x284.png`,
      ]),
      "review/contact/A.png",
      "review/contact/B.png",
      "review/contact/C.png",
      "review/key.json",
      "manifest.json",
    ];
    expect([...result.files].sort()).toEqual([...expected].sort());
    expect(deps.calls.filter((call) => call === "rasterize")).toHaveLength(
      stills.length * STYLE_CANDIDATES.length,
    );
    expect(deps.calls.filter((call) => call.startsWith("motion:"))).toEqual(
      STYLE_CANDIDATES.map(() => "motion:6000"),
    );
    // Only the candidate with a store plate gets the night and warm grades.
    expect(deps.calls.filter((call) => call.startsWith("grade:"))).toEqual([
      "grade:night",
      "grade:warm",
    ]);

    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as {
      gitHead: string;
      ownerVisualApproval: string;
      candidates: {
        id: string;
        shots: { id: string; plate: string }[];
        plates: Record<string, unknown>;
      }[];
      review: { blindSeed: number };
    };
    expect(manifest.gitHead).toBe("abc123");
    expect(manifest.ownerVisualApproval).toBe("PENDING");
    expect(manifest.review.blindSeed).toBe(7);
    const cutout = manifest.candidates.find((c) => c.id === "expressive-ink-cutout-painted");
    expect(cutout?.shots.find((s) => s.id === "03-establishing-wide")?.plate).toBe("plate");
    expect(cutout?.shots.find((s) => s.id === "08-night-tension")?.plate).toBe("graded_plate");
    expect(cutout?.shots.find((s) => s.id === "06-two-character-dialogue")?.plate).toBe("fallback");
    expect(cutout?.plates.office).toMatchObject({ fallback: expect.any(String) });
    const control = manifest.candidates.find((c) => c.id === "flat-vector-control");
    expect(control?.shots.every((s) => s.plate === "procedural")).toBe(true);

    const key = JSON.parse(await readFile(join(dir, "review/key.json"), "utf8")) as {
      key: Record<string, Record<string, string>>;
    };
    expect(Object.values(key.key["03-establishing-wide"] ?? {}).sort()).toEqual(
      STYLE_CANDIDATES.map((c) => c.id).sort(),
    );
    expect(Object.values(key.key.contact ?? {}).sort()).toEqual(
      STYLE_CANDIDATES.map((c) => c.id).sort(),
    );
  });

  it("renders a candidate subset with stills only", async () => {
    dir = await mkdtemp(join(tmpdir(), "style-frames-"));
    const deps = fakeDeps();
    const result = await renderStyleFrames(deps, {
      outDir: dir,
      candidates: ["flat-vector-control"],
      skipMotion: true,
    });
    expect(result.files.some((file) => file.endsWith(".mp4"))).toBe(false);
    expect(result.files).toContain("review/contact/A.png");
    expect(result.files).not.toContain("review/contact/B.png");
    expect(deps.calls.some((call) => call.startsWith("motion:"))).toBe(false);
  });

  it("post-processes plates, plans with the profile and measures the halo on frames 3, 6 and 8", async () => {
    dir = await mkdtemp(join(tmpdir(), "style-frames-"));
    const deps = fakeDeps(new Set(["expressive-ink-cutout-painted/store"]));
    const processed: string[] = [];
    const withCompositing: StyleFrameDeps = {
      ...deps,
      postProcessPlate: async (plate, plan) => {
        processed.push(String(plan.farValuePull));
        return { ...plate, provenance: { postProcess: true } };
      },
      focalContrast: async () => ({ contrast: 0.3, maskPx: 10, ringPx: 20 }),
    };
    await renderStyleFrames(withCompositing, {
      outDir: dir,
      candidates: ["expressive-ink-cutout-painted"],
      skipMotion: true,
      compositing: COMPOSITING_HYPOTHESIS,
    });
    expect(processed).toEqual(["0.3"]);
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as {
      compositing: { depth: { far: number } };
      candidates: { shots: { frame: number; halo?: { verdict: string; target: number } }[] }[];
    };
    expect(manifest.compositing.depth.far).toBe(0.2);
    const halos = manifest.candidates[0]?.shots.filter((shot) => shot.halo) ?? [];
    expect([...new Set(halos.map((shot) => shot.frame))]).toEqual([3, 6, 8]);
    expect(halos.every((shot) => shot.halo?.verdict === "pass" && shot.halo.target === 0.25)).toBe(
      true,
    );
  });

  it("refuses an unknown candidate list", async () => {
    dir = await mkdtemp(join(tmpdir(), "style-frames-"));
    await expect(
      renderStyleFrames(fakeDeps(), { outDir: dir, candidates: ["nope"] }),
    ).rejects.toThrow("style_candidates_empty");
  });
});

describe("renderActingSwap", () => {
  it("writes one blind strip per acting preset and a key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acting-swap-"));
    try {
      const files = await renderActingSwap(fakeDeps(), { outDir: dir, blindSeed: 3 });
      expect(files).toEqual([
        "review/acting/A.png",
        "review/acting/B.png",
        "review/acting/C.png",
        "review/acting/D.png",
        "review/acting/E.png",
        "review/acting/F.png",
        "review/acting/key.json",
      ]);
      const key = JSON.parse(await readFile(join(dir, "review/acting/key.json"), "utf8")) as {
        key: Record<string, string>;
      };
      expect(Object.values(key.key).sort()).toEqual([
        "calm",
        "energetic",
        "nervous",
        "neutral",
        "showman",
        "weary",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("blindOrder", () => {
  it("is a deterministic permutation", () => {
    const order = blindOrder(42, 5);
    expect([...order].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(blindOrder(42, 5)).toEqual(order);
    expect(blindOrder(43, 5)).not.toEqual(order);
  });
});

describe("generatePlates", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("asks the generator once per fixture background per painted candidate and records provenance", async () => {
    dir = await mkdtemp(join(tmpdir(), "style-plates-"));
    const prompts: string[] = [];
    const generate = async (prompt: string) => {
      prompts.push(prompt);
      return {
        bytes: png(prompt),
        mimeType: "image/png" as const,
        neurons: 173,
        width: 1024,
        height: 1024,
      };
    };
    const written = await generatePlates({
      platesDir: dir,
      generate,
      now: () => new Date("2026-09-30T20:00:00Z"),
    });
    const painted = STYLE_CANDIDATES.filter((c) => c.plateStyle);
    expect(written).toHaveLength(painted.length * fixtureBackgrounds().length);
    expect(prompts.some((p) => p.includes("watercolor"))).toBe(true);
    const provenance = JSON.parse(
      await readFile(join(dir, "expressive-ink-cutout-painted/store.json"), "utf8"),
    ) as { model: string; promptVersion: number; sha256: string };
    expect(provenance.model).toBe("workers-ai:flux-1-schnell");
    expect(provenance.promptVersion).toBe(1);
    expect(provenance.sha256).toHaveLength(64);
    // Resumable: a second run generates nothing.
    expect(await generatePlates({ platesDir: dir, generate, now: () => new Date() })).toEqual([]);
  });
});

describe("sam-plates", () => {
  it("renders the three Sam shots with Sam's wardrobe and no caption", async () => {
    const svgs: string[] = [];
    const deps = fakeDeps(new Set(["expressive-ink-gouache-painted/store"]));
    const out = await mkdtemp(join(tmpdir(), "sam-plates-"));
    try {
      const files = await renderSamPlates(
        {
          ...deps,
          rasterize: async (svg) => {
            svgs.push(svg);
            return png("frame");
          },
        },
        { outDir: out },
      );
      expect(files.map((file) => file.split("/").at(-1))).toEqual(
        SAM_PLATE_SHOTS.map((id) => `sam-expressive-ink-gouache-painted-${id}.png`),
      );
      expect(SAM_PLATE_CAST.find((c) => c.key === "alex")?.wardrobe).toEqual(SAM.wardrobe);
      for (const svg of svgs) {
        expect(svg).not.toContain("esconde");
        expect(svg).not.toContain("Alex");
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
