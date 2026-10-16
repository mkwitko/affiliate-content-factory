import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRealEsrganUpscaler } from "./realesrgan-upscaler.js";

describe("createRealEsrganUpscaler", () => {
  it("runs the binary on a temp file with the anime model at x2 and returns its output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-esrgan-"));
    const exe = join(dir, "realesrgan-ncnn-vulkan");
    // Fake binary: records its arguments and writes the input bytes reversed as the output.
    await writeFile(
      exe,
      `#!/bin/sh\necho "$@" > "${dir}/args"\nin=$2; out=$4\nrev < "$in" > "$out"\n`,
    );
    await chmod(exe, 0o755);
    const out = await createRealEsrganUpscaler({ exe, gpu: -1 })(new TextEncoder().encode("abc\n"));
    expect(new TextDecoder().decode(out)).toBe("cba\n");
    const args = await readFile(join(dir, "args"), "utf8");
    expect(args).toMatch(/-n realesr-animevideov3 -s 2 -f png -g -1/);
  });
});
