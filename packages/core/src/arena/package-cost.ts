/**
 * Phase 8 (owner brief 2026-10-08, section 25): what a package that would pass review costs in
 * home GPU time, and how sure the sample lets us be. Time only: no energy price is on record,
 * so no money figure is derived.
 */
export type PackageRun = Readonly<{
  copy: string;
  /** Share of the package's scenes the fidelity judge passed, 0..1. */
  productFidelity: number | null;
  extraPersonRate: number | null;
  reelQa: string | null;
  /** Mean drawing time per scene this run, ms (scenes kept from an earlier run cost 0 here). */
  sceneMs: number | null;
  sceneCount: number | null;
  reelMs: number | null;
}>;

/** A package the automatic gates would hand to review: every scene passes, Reel QA not blocked. */
export const packageWouldPass = (run: PackageRun): boolean =>
  run.copy === "ok" &&
  run.productFidelity === 1 &&
  (run.extraPersonRate ?? 0) === 0 &&
  (run.reelQa === "pass" || run.reelQa === "warn");

/** Wilson score interval (95 %) for k successes in n; null for an empty sample. */
export const wilsonInterval = (
  k: number,
  n: number,
  z = 1.96,
): Readonly<{ low: number; high: number }> | null => {
  if (n <= 0) return null;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const spread = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return { low: round(Math.max(0, centre - spread)), high: round(Math.min(1, centre + spread)) };
};

export type PackageCost = Readonly<{
  packages: number;
  passing: number;
  passRate: number | null;
  passRate95: Readonly<{ low: number; high: number }> | null;
  /** All GPU time of the sample divided by the packages that would pass; null when none did. */
  gpuSecPerPassingPackage: number | null;
}>;

export const packageCost = (runs: readonly PackageRun[]): PackageCost => {
  const passing = runs.filter(packageWouldPass).length;
  const gpuMs = runs.reduce(
    (sum, run) => sum + (run.sceneMs ?? 0) * (run.sceneCount ?? 0) + (run.reelMs ?? 0),
    0,
  );
  return {
    packages: runs.length,
    passing,
    passRate: runs.length ? Math.round((passing / runs.length) * 1000) / 1000 : null,
    passRate95: wilsonInterval(passing, runs.length),
    gpuSecPerPassingPackage: passing ? Math.round(gpuMs / passing / 1000) : null,
  };
};
