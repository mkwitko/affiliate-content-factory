import { SceneClipSubmitError } from "@money-maker/core/assets/scene-clip-generator";
import { describe, expect, it } from "vitest";
import { parseTrialArgs, runCloudClipTrial, type TrialDeps } from "./cloud-clip-trial.js";

const ws = "7fb9427e-8d67-49aa-80f6-ec915bea7206";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
const now = new Date("2026-10-14T12:00:00Z");

const deps = (overrides: Partial<TrialDeps> = {}) => {
  const calls: string[] = [];
  let polls = 0;
  const value: TrialDeps = {
    readImage: async () => png,
    putPlate: async (key) => void calls.push(`put:${key}`),
    plateUrl: async (key) => `https://acct.r2.cloudflarestorage.com/${key}`,
    generator: {
      submit: async (request) => {
        calls.push(`submit:${request.budget?.operationKey}`);
        return { providerTaskId: "t1", model: "m" };
      },
      poll: async () =>
        ++polls < 2 ? { status: "pending" } : { status: "completed", url: "https://r2/clip" },
    },
    fx: async () => ({ brlPerUsd: 4.9892, source: "bcb-ptax-venda:10-13-2026", at: now }),
    fetchClip: async () => new Uint8Array([1, 2, 3]),
    checkClip: async () => ({ ok: true }),
    writeClip: async (path) => void calls.push(`write:${path}`),
    reservations: async () => [],
    sleep: async () => undefined,
    now: () => now,
    ...overrides,
  };
  return { value, calls };
};
const args = (extra: string[] = []) =>
  parseTrialArgs(["--workspace", ws, "--image", "sam.png", "--prompt", "Sam waves", ...extra]);

describe("cloud-clip-trial", () => {
  it("dry run prints the worst case and never uploads or submits", async () => {
    const { value, calls } = deps();
    expect(await runCloudClipTrial(value, args())).toMatchObject({
      mode: "dry_run",
      worstCaseMinor: 1729,
      width: 720,
      height: 1280,
    });
    expect(calls).toEqual([]);
  });

  it("execute uploads the plate, submits once with a budget key, polls, checks and writes the clip", async () => {
    const { value, calls } = deps();
    const report = await runCloudClipTrial(value, args(["--execute", "--out", "/tmp/x"]));
    expect(report).toMatchObject({ mode: "completed", verdict: { ok: true } });
    expect(calls[0]).toMatch(
      new RegExp(`^put:workspaces/${ws}/cloud-gpu/trials/[0-9a-f]{64}\\.png$`),
    );
    expect(calls.filter((call) => call.startsWith("submit:"))).toHaveLength(1);
    expect(calls.at(-1)).toMatch(/^write:\/tmp\/x\/trial_[0-9a-f]{16}_[0-9a-f]{8}\.mp4$/);
  });

  it("reports a budget refusal instead of throwing", async () => {
    const { value } = deps({
      generator: {
        submit: async () => {
          throw new SceneClipSubmitError("budget_exhausted", false);
        },
        poll: async () => ({ status: "pending" }),
      },
    });
    expect(await runCloudClipTrial(value, args(["--execute"]))).toMatchObject({
      mode: "refused",
      code: "budget_exhausted",
    });
  });

  it("refuses a file that is not PNG or JPEG", async () => {
    const { value } = deps({ readImage: async () => new Uint8Array([1, 2, 3]) });
    await expect(runCloudClipTrial(value, args())).rejects.toThrow(
      "cloud_clip_trial_image_not_png_or_jpeg",
    );
  });
});
