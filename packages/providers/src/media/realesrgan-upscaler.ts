import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Real-ESRGAN x2 (`realesr-animevideov3`, BSD-3-Clause, made for flat drawn art) through the
 * ncnn Vulkan binary. A Windows `.exe` run from WSL gets Windows paths through `wslpath -w`.
 * `gpu: -1` runs on the CPU, which keeps the 8 GB card free for the image editor.
 */
export const createRealEsrganUpscaler =
  (options: Readonly<{ exe: string; gpu?: number; timeoutMs?: number }>) =>
  async (png: Uint8Array): Promise<Uint8Array> => {
    const dir = await mkdtemp(join(tmpdir(), "mm-upscale-"));
    try {
      const input = join(dir, "in.png");
      const output = join(dir, "out.png");
      await writeFile(input, png);
      const path = async (file: string) =>
        options.exe.endsWith(".exe")
          ? (await execFileAsync("wslpath", ["-w", file])).stdout.trim()
          : file;
      await execFileAsync(
        options.exe,
        [
          "-i",
          await path(input),
          "-o",
          await path(output),
          "-n",
          "realesr-animevideov3",
          "-s",
          "2",
          "-f",
          "png",
          ...(options.gpu !== undefined ? ["-g", String(options.gpu)] : []),
        ],
        // The binary finds its models folder next to itself.
        { cwd: dirname(options.exe), timeout: options.timeoutMs ?? 600_000 },
      );
      return new Uint8Array(await readFile(output));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
