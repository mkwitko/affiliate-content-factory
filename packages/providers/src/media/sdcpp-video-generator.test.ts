import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { localClipProfile } from "@money-maker/core/assets/local-clip-profile";
import { createSdCppVideoGenerator } from "./sdcpp-video-generator.js";

const WAN = "local:wan2.2-ti2v-5b";
const options = { baseUrl: "http://127.0.0.1:7861", model: WAN, pollMs: 1, allowDisabled: true };
const profile = (() => {
  const made = localClipProfile({ canvas: "portrait", seconds: 2 });
  if (!made) throw new Error("profile");
  return made;
})();
const reference = async () =>
  new Uint8Array(
    await sharp({ create: { width: 64, height: 64, channels: 3, background: "white" } })
      .png()
      .toBuffer(),
  );
const input = async () => ({
  prompt: "a cat walks",
  negativePrompt: "logos",
  reference: await reference(),
  profile,
});
const webm = Buffer.from("not really a webm").toString("base64");
const done = {
  status: "completed",
  result: { output_format: "webm", mime_type: "video/webm", b64_json: webm, frame_count: 33 },
};

describe("sdcpp video generator", () => {
  it("is refused while model policy keeps the model disabled, unless a benchmark allows it", () => {
    expect(() => createSdCppVideoGenerator({ baseUrl: options.baseUrl, model: WAN })).toThrow(
      "sdcpp_model_not_allowed",
    );
    expect(() =>
      createSdCppVideoGenerator({
        baseUrl: options.baseUrl,
        model: "local:z-image-turbo",
        allowDisabled: true,
      }),
    ).toThrow("sdcpp_model_not_allowed");
    expect(() => createSdCppVideoGenerator(options)).not.toThrow();
  });

  it("refuses non-local hosts", () => {
    expect(() => createSdCppVideoGenerator({ ...options, baseUrl: "http://example.com" })).toThrow(
      "sdcpp_url_not_local",
    );
  });

  it("submits vid_gen with the profile and init image, polls, returns webm bytes", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ supported_modes: ["vid_gen"], model: { name: "Wan" } }),
      )
      .mockResolvedValueOnce(Response.json({ id: "job_v1", status: "queued" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ status: "generating" }))
      .mockResolvedValueOnce(Response.json(done));
    const clip = await createSdCppVideoGenerator({ ...options, fetch }).generate(await input());
    expect(clip).toMatchObject({
      mimeType: "video/webm",
      model: WAN,
      provenance: { runtime: "stable-diffusion.cpp", observedModel: "Wan" },
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:7861/sdcpp/v1/capabilities",
      "http://127.0.0.1:7861/sdcpp/v1/vid_gen",
      "http://127.0.0.1:7861/sdcpp/v1/jobs/job_v1",
      "http://127.0.0.1:7861/sdcpp/v1/jobs/job_v1",
    ]);
    const body = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(body).toMatchObject({
      width: 480,
      height: 832,
      video_frames: 33,
      fps: 16,
      sample_params: { sample_steps: 20 },
      output_format: "webm",
    });
    expect(typeof body.init_image).toBe("string");
  });

  it("rejects profiles over the caps before any request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createSdCppVideoGenerator({ ...options, fetch, maxFrames: 17 }).generate(await input()),
    ).rejects.toThrow("sdcpp_video_profile_invalid");
    await expect(
      createSdCppVideoGenerator({ ...options, fetch }).generate({
        ...(await input()),
        profile: { ...profile, steps: 60 },
      }),
    ).rejects.toThrow("sdcpp_video_profile_invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails when the server lacks vid_gen", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ supported_modes: ["img_gen"] }));
    await expect(
      createSdCppVideoGenerator({ ...options, fetch }).generate(await input()),
    ).rejects.toThrow("sdcpp_video_unavailable");
  });

  it("cancels the job on a malformed result", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ supported_modes: ["vid_gen"] }))
      .mockResolvedValueOnce(Response.json({ id: "job_v2" }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({ status: "completed", result: { mime_type: "video/mp4" } }),
      )
      .mockResolvedValueOnce(Response.json({}));
    await expect(
      createSdCppVideoGenerator({ ...options, fetch }).generate(await input()),
    ).rejects.toThrow("sdcpp_video_invalid");
    expect(String(fetch.mock.calls.at(-1)?.[0])).toBe(
      "http://127.0.0.1:7861/sdcpp/v1/jobs/job_v2/cancel",
    );
  });

  it("times out with sdcpp_timeout and cancels", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).endsWith("capabilities"))
        return Response.json({ supported_modes: ["vid_gen"] });
      if (String(url).endsWith("vid_gen")) return Response.json({ id: "job_v3" }, { status: 202 });
      if (String(url).endsWith("/cancel")) return Response.json({});
      return Response.json({ status: "generating" });
    });
    await expect(
      createSdCppVideoGenerator({ ...options, fetch, timeoutMs: 10_000, pollMs: 2_000 }).generate(
        await input(),
      ),
    ).rejects.toThrow("sdcpp_timeout");
    expect(String(fetch.mock.calls.at(-1)?.[0])).toContain("/cancel");
  }, 20_000);
});
