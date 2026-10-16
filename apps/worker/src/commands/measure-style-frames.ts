// apps/worker/src/commands/measure-style-frames.ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FLAT_VECTOR_PROFILE,
  lintVisualLanguageProfile,
  type ProfileLintIssue,
  readVisualLanguageProfile,
  type VisualLanguageProfile,
} from "@money-maker/core/explainer/visual-language";
import type { FrameMeasurements } from "@money-maker/providers/media/style-frame-metrics";

/**
 * Measures a style-frame harness output (v2 slice 18) and writes, per candidate, the
 * measurements and a DRAFT VisualLanguageProfile built from them. A draft is evidence for the
 * owner's review, never a niche setting: `update_niche_context` with the accepted candidate's
 * profile is the owner's step after the review (spec section 9).
 */
type ManifestShot = Readonly<{
  file: string;
  halo?: Readonly<{ contrast: number; heroAreaPct?: number }>;
}>;
type ManifestCandidate = Readonly<{
  id: string;
  characterStyle: VisualLanguageProfile["characterStyle"];
  environmentStyle: VisualLanguageProfile["environmentStyle"];
  shots: readonly ManifestShot[];
}>;
export type StyleFrameManifest = Readonly<{
  gitHead?: string;
  candidates: readonly ManifestCandidate[];
  compositing?: unknown;
}>;

const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};
const up = (value: number) => Math.min(1, Math.ceil((value + 0.05) * 100) / 100);

export type CandidateMeasurement = Readonly<{
  candidate: string;
  status: "draft_owner_review_pending";
  measurements: FrameMeasurements &
    Readonly<{ haloContrastMedian: number | null; heroAreaPct: readonly [number, number] | null }>;
  profile: VisualLanguageProfile;
  lint: readonly ProfileLintIssue[];
}>;

/** Pure: a draft profile from one candidate's measurements, starting from FLAT_VECTOR. */
export const draftProfile = (
  candidate: ManifestCandidate,
  metrics: FrameMeasurements,
  compositing: unknown,
): CandidateMeasurement => {
  const halos = candidate.shots.flatMap((shot) => (shot.halo ? [shot.halo.contrast] : []));
  const areas = candidate.shots.flatMap((shot) =>
    shot.halo?.heroAreaPct !== undefined ? [shot.halo.heroAreaPct] : [],
  );
  const halo = median(halos);
  const heroArea: readonly [number, number] | null = areas.length
    ? [Math.min(...areas), Math.max(...areas)]
    : null;
  const d = FLAT_VECTOR_PROFILE;
  const profile =
    readVisualLanguageProfile({
      id: `${candidate.id}-draft`,
      version: 1,
      characterStyle: candidate.characterStyle,
      environmentStyle: candidate.environmentStyle,
      palette: {
        areaMax: {
          dominant: up(metrics.dominantArea),
          secondary: up(metrics.secondaryArea),
          accent: up(metrics.accentArea),
        },
      },
      value: {
        areaTarget: metrics.valueTiers,
        minFocalDeltaL: halo ?? d.value.minFocalDeltaL,
      },
      composition: heroArea ? { heroAreaPct: heroArea } : {},
      ...(compositing ? { compositing } : {}),
    }) ?? d;
  return {
    candidate: candidate.id,
    status: "draft_owner_review_pending",
    measurements: { ...metrics, haloContrastMedian: halo ?? null, heroAreaPct: heroArea },
    profile,
    lint: lintVisualLanguageProfile(profile),
  };
};

const main = async (): Promise<void> => {
  const [dir] = process.argv.slice(2);
  if (!dir) throw new Error("usage: measure-style-frames.js <style-frames-out>");
  const { measureFrames } = await import("@money-maker/providers/media/style-frame-metrics");
  const manifest = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  ) as StyleFrameManifest;
  const results: CandidateMeasurement[] = [];
  for (const candidate of manifest.candidates) {
    const pngs = await Promise.all(
      candidate.shots.map(async (shot) => new Uint8Array(await readFile(join(dir, shot.file)))),
    );
    const metrics = await measureFrames(pngs, FLAT_VECTOR_PROFILE.palette.roles.accent);
    const result = draftProfile(candidate, metrics, manifest.compositing);
    await writeFile(
      join(dir, candidate.id, "draft-profile.json"),
      `${JSON.stringify(result, null, 1)}\n`,
    );
    results.push(result);
  }
  console.log(
    JSON.stringify(
      results.map((r) => ({
        candidate: r.candidate,
        ...r.measurements,
        lint: r.lint.map((i) => i.id),
      })),
      null,
      1,
    ),
  );
};

if (process.argv[1]?.endsWith("measure-style-frames.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "measure style frames failed");
    process.exitCode = 1;
  });
}
