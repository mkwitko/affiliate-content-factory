import { describe, expect, it } from "vitest";
import { type PackageRun, packageCost, packageWouldPass, wilsonInterval } from "./package-cost.js";

const run = (over: Partial<PackageRun> = {}): PackageRun => ({
  copy: "ok",
  productFidelity: 1,
  extraPersonRate: 0,
  reelQa: "pass",
  sceneMs: 200_000,
  sceneCount: 5,
  reelMs: 30_000,
  ...over,
});

describe("package cost", () => {
  it("passes only a package with every scene right, no extra person and a usable Reel", () => {
    expect(packageWouldPass(run())).toBe(true);
    expect(packageWouldPass(run({ reelQa: "warn" }))).toBe(true);
    expect(packageWouldPass(run({ productFidelity: 0.8 }))).toBe(false);
    expect(packageWouldPass(run({ extraPersonRate: 0.2 }))).toBe(false);
    expect(packageWouldPass(run({ reelQa: "block" }))).toBe(false);
    expect(packageWouldPass(run({ copy: "slide_count" }))).toBe(false);
  });

  it("charges the whole sample's GPU time to the packages that would pass", () => {
    const cost = packageCost([run(), run({ productFidelity: 0.6 })]);
    // (200 s x 5 + 30 s) x 2 packages / 1 passing.
    expect(cost).toMatchObject({
      packages: 2,
      passing: 1,
      passRate: 0.5,
      gpuSecPerPassingPackage: 2060,
    });
    expect(packageCost([run({ productFidelity: 0 })]).gpuSecPerPassingPackage).toBeNull();
  });

  it("states the uncertainty of small samples", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(1, 1)).toEqual({ low: 0.207, high: 1 });
    expect(wilsonInterval(13, 26)).toEqual({ low: 0.321, high: 0.679 });
  });
});
