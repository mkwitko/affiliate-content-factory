import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCommandSceneGenerator } from "./command-scene-generator.js";

/** A fake local CLI: a CommonJS node script (no package.json in its folder) run by its shebang. */
const script = (body: string) =>
  `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nconst arg = (name) => args[args.indexOf(name) + 1];\n${body}\n`;

describe("createCommandSceneGenerator", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "scene-cmd-"));
    const png = await sharp({
      create: { width: 768, height: 1344, channels: 3, background: "#3366aa" },
    })
      .png()
      .toBuffer();
    await writeFile(join(dir, "fixture.png"), png);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const fake = async (name: string, body: string): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, script(body));
    await chmod(path, 0o755);
    return path;
  };

  it("passes prompt, size and a prompt-derived seed as arguments and returns the image with provenance", async () => {
    const argsFile = join(dir, "args.json");
    const command = await fake(
      "ok",
      `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args)); fs.copyFileSync(${JSON.stringify(join(dir, "fixture.png"))}, arg("--out")); console.log("sd: sampling done");`,
    );
    const generator = createCommandSceneGenerator({ command, model: "local:z-image-turbo" });
    const prompt = "a kitchen; rm -rf / $(whoami)";
    const first = await generator.generate(prompt, { width: 768, height: 1344 });
    expect(first).toMatchObject({
      mimeType: "image/png",
      width: 768,
      height: 1344,
      neurons: 0,
      model: "local:z-image-turbo",
      license: "Apache-2.0 (local:z-image-turbo, local)",
    });
    const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    expect(args.slice(0, 6)).toEqual(["--prompt", prompt, "--width", "768", "--height", "1344"]);
    expect(args[args.indexOf("--seed") + 1]).toBe(String(first.seed));
    expect((await generator.generate(prompt)).seed).toBe(first.seed);
  });

  it("names timeouts, failures and missing or invalid images, and removes its temp directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "scene-cmd-root-"));
    const cases = [
      ["hang", "setTimeout(() => undefined, 60_000);", "scene_provider_timeout", 300],
      ["exit", "process.exit(3);", "scene_provider_error:command", 10_000],
      ["none", "", "scene_provider_response_invalid", 10_000],
      [
        "text",
        `fs.writeFileSync(arg("--out"), "not an image");`,
        "scene_provider_response_invalid",
        10_000,
      ],
    ] as const;
    for (const [name, body, error, timeoutMs] of cases) {
      const generator = createCommandSceneGenerator({
        command: await fake(name, body),
        model: "local:flux-1-schnell",
        timeoutMs,
        tmpRoot: root,
      });
      await expect(generator.generate("an open sky")).rejects.toThrow(error);
    }
    expect(await readdir(root)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("passes a style reference image as --reference only when one is given", async () => {
    const argsFile = join(dir, "args-ref.json");
    const seenFile = join(dir, "seen-ref.txt");
    const command = await fake(
      "ref",
      `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args)); if (args.includes("--reference")) fs.writeFileSync(${JSON.stringify(seenFile)}, fs.readFileSync(arg("--reference"))); fs.copyFileSync(${JSON.stringify(join(dir, "fixture.png"))}, arg("--out"));`,
    );
    const generator = createCommandSceneGenerator({ command, model: "local:flux-2-klein-4b" });
    await generator.generate("a place", { width: 768, height: 1344 });
    expect(JSON.parse(await readFile(argsFile, "utf8"))).not.toContain("--reference");
    await generator.generate(
      "a place",
      { width: 768, height: 1344 },
      { reference: new Uint8Array([7, 8]) },
    );
    expect(JSON.parse(await readFile(argsFile, "utf8"))).toContain("--reference");
    expect([...(await readFile(seenFile))]).toEqual([7, 8]);
  });

  it("refuses Bonsai Image on the AMD desktop", () => {
    expect(() =>
      createCommandSceneGenerator({
        command: "/bin/true",
        model: "local:bonsai-image-4b",
        machineKind: "desktop_amd",
      }),
    ).toThrow("scene_generator_model_refused_on_machine");
  });

  it("refuses a model outside the licence allowlist", () => {
    expect(() =>
      createCommandSceneGenerator({ command: "/bin/true", model: "local:ltx-2.3" }),
    ).toThrow("scene_generator_model_unknown");
  });
});
