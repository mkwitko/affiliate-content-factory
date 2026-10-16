import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createSdCppImageEditor, createSdCppSceneGenerator } from "./sdcpp-scene-generator.js";

const options = { baseUrl: "http://127.0.0.1:7860", model: "local:z-image-turbo", pollMs: 1 };

describe("sdcpp scene generator", () => {
  it("submits, polls, and returns validated image bytes", async () => {
    const png = (
      await sharp({ create: { width: 512, height: 512, channels: 3, background: "white" } })
        .png()
        .toBuffer()
    ).toString("base64");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ supported_modes: ["img_gen"], model: { name: "Z-Image" } }),
      )
      .mockResolvedValueOnce(Response.json({ id: "job_1", status: "queued" }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          id: "job_1",
          status: "completed",
          result: { output_format: "png", images: [{ index: 0, b64_json: png }] },
        }),
      );
    const generator = createSdCppSceneGenerator({ ...options, fetch });
    const image = await generator.generate("a kitchen", { width: 512, height: 512 });
    expect(image.model).toBe("local:z-image-turbo");
    expect(image.bytes.byteLength).toBeGreaterThan(0);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:7860/sdcpp/v1/capabilities",
      "http://127.0.0.1:7860/sdcpp/v1/img_gen",
      "http://127.0.0.1:7860/sdcpp/v1/jobs/job_1",
    ]);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      width: 512,
      height: 512,
      batch_count: 1,
      output_format: "png",
    });
  });

  it("sends configured sampling steps and reports the deadline as sdcpp_timeout", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ supported_modes: ["img_gen"] }))
      .mockResolvedValueOnce(Response.json({ id: "job_t" }, { status: 202 }))
      .mockImplementationOnce(async () => {
        deadline.abort(new DOMException("timed out", "TimeoutError"));
        throw deadline.signal.reason;
      })
      .mockResolvedValue(new Response(null, { status: 200 }));
    try {
      const generator = createSdCppSceneGenerator({ ...options, fetch, steps: 8 });
      await expect(generator.generate("a kitchen", { width: 512, height: 512 })).rejects.toThrow(
        "sdcpp_timeout",
      );
    } finally {
      timeout.mockRestore();
    }
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      sample_params: { sample_steps: 8 },
    });
    expect(() =>
      createSdCppSceneGenerator({ ...options, cacheMode: "warp" as "easycache" }),
    ).toThrow("sdcpp_limits_invalid");
    expect(() => createSdCppSceneGenerator({ ...options, referenceMaxSide: 100 })).toThrow(
      "sdcpp_limits_invalid",
    );
    expect(() => createSdCppSceneGenerator({ ...options, steps: 0 })).toThrow(
      "sdcpp_limits_invalid",
    );
  });

  it("keeps the runtime's failure message as the error cause", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ supported_modes: ["img_gen"] }))
      .mockResolvedValueOnce(Response.json({ id: "job_f" }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({ status: "failed", error: { code: "generation_failed", message: "oom" } }),
      )
      .mockResolvedValue(new Response(null, { status: 200 }));
    const error = await createSdCppSceneGenerator({ ...options, fetch })
      .generate("a kitchen", { width: 512, height: 512 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("sdcpp_job_failed");
    expect((error as Error).cause).toBe("oom");
  });

  it("sends a pinned seed and rejects an invalid one before calling the runtime", async () => {
    const png = (
      await sharp({ create: { width: 512, height: 512, channels: 3, background: "white" } })
        .png()
        .toBuffer()
    ).toString("base64");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ supported_modes: ["img_gen"] }))
      .mockResolvedValueOnce(Response.json({ id: "job_s" }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          status: "completed",
          result: { output_format: "png", images: [{ index: 0, b64_json: png }] },
        }),
      );
    const generator = createSdCppSceneGenerator({ ...options, fetch });
    await generator.generate("a kitchen", { width: 512, height: 512 }, { seed: 1234 });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ seed: 1234 });
    const untouched = vi.fn<typeof globalThis.fetch>();
    await expect(
      createSdCppSceneGenerator({ ...options, fetch: untouched }).generate("x", undefined, {
        seed: -1,
      }),
    ).rejects.toThrow("sdcpp_seed_invalid");
    expect(untouched).not.toHaveBeenCalled();
  });

  it("rejects invalid dimensions before calling the runtime", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createSdCppSceneGenerator({ ...options, fetch }).generate("x", { width: 5000, height: 512 }),
    ).rejects.toThrow("sdcpp_image_size_invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels a job after malformed or oversized output", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ supported_modes: ["img_gen"] }))
      .mockResolvedValueOnce(Response.json({ id: "job_2" }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({ status: "completed", result: { images: [{ b64_json: "bad" }] } }),
      )
      .mockResolvedValueOnce(Response.json({ status: "cancelled" }));
    await expect(createSdCppSceneGenerator({ ...options, fetch }).generate("x")).rejects.toThrow();
    expect(String(fetch.mock.calls.at(-1)?.[0])).toContain("/jobs/job_2/cancel");
  });

  it("rejects public runtime endpoints", () => {
    expect(() => createSdCppSceneGenerator({ ...options, baseUrl: "https://example.com" })).toThrow(
      "sdcpp_url_not_local",
    );
  });

  it("keeps reference edits behind a distinct image editor and sends bytes, not paths", async () => {
    const source = await sharp({
      create: { width: 512, height: 512, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const output = await sharp({
      create: { width: 512, height: 512, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ supported_modes: ["img_gen"], model: { name: "FLUX.2 Klein" } }),
      )
      .mockResolvedValueOnce(Response.json({ id: "job_3" }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          status: "completed",
          result: { output_format: "png", images: [{ b64_json: output.toString("base64") }] },
        }),
      );
    const editor = createSdCppImageEditor({ ...options, model: "local:flux-2-klein-4b", fetch });
    const edited = await editor.edit(
      "preserve product, change background",
      new Uint8Array(source),
      { width: 512, height: 512 },
      { seed: 42 },
    );
    expect(edited.provenance?.runtime).toBe("stable-diffusion.cpp");
    expect(edited.seed).toBe(42);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).seed).toBe(42);
    const [sentSource] = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).ref_images as string[];
    const meta = await sharp(Buffer.from(sentSource ?? "", "base64")).metadata();
    expect(meta.format).toBe("png");
  });

  it("sends several references in order, shrunk to 768 px, and refuses more than four", async () => {
    const png = (background: string, width = 512) =>
      sharp({ create: { width, height: 512, channels: 3, background } })
        .png()
        .toBuffer();
    const [red, green] = await Promise.all([png("red"), png("green", 2048)]);
    const output = await png("blue");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ supported_modes: ["img_gen"] }))
      .mockResolvedValueOnce(Response.json({ id: "job_4" }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          status: "completed",
          result: { output_format: "png", images: [{ b64_json: output.toString("base64") }] },
        }),
      );
    const editor = createSdCppImageEditor({ ...options, model: "local:flux-2-klein-4b", fetch });
    await editor.edit("scene", [new Uint8Array(red), new Uint8Array(green)], {
      width: 512,
      height: 512,
    });
    const sent = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).ref_images as string[];
    expect(sent).toHaveLength(2);
    const pixel = async (b64: string | undefined) => {
      const image = sharp(Buffer.from(b64 ?? "", "base64"));
      const { width } = await image.metadata();
      const { data } = await image.raw().toBuffer({ resolveWithObject: true });
      return { width, rgb: [...data.subarray(0, 3)] };
    };
    expect(await pixel(sent[0])).toEqual({ width: 512, rgb: [255, 0, 0] });
    expect(await pixel(sent[1])).toEqual({ width: 768, rgb: [0, 128, 0] });
    const five = Array.from({ length: 5 }, () => new Uint8Array(red));
    await expect(editor.edit("scene", five, { width: 512, height: 512 })).rejects.toThrow(
      "sdcpp_reference_invalid",
    );
  });
});

describe("sdcpp arena mode", () => {
  const base = { baseUrl: "http://127.0.0.1:1234" };
  it("refuses a disabled challenger in production and allows it in a benchmark", () => {
    expect(() =>
      createSdCppImageEditor({ ...base, model: "local:longcat-image-edit-turbo" }),
    ).toThrow("sdcpp_model_not_allowed");
    expect(() =>
      createSdCppImageEditor({ ...base, model: "local:mage-flow-edit-4b-turbo", arena: true }),
    ).not.toThrow();
  });

  it("never runs a research-only or unregistered model, even in a benchmark", () => {
    expect(() =>
      createSdCppSceneGenerator({ ...base, model: "Qwen/Qwen-Image-2.1", arena: true }),
    ).toThrow("sdcpp_model_not_allowed");
    expect(() => createSdCppImageEditor({ ...base, model: "local:nope", arena: true })).toThrow(
      "sdcpp_model_not_allowed",
    );
  });
});
