import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCENE_PALETTE } from "@money-maker/core/explainer/explainer-context";
import { COST_CURIOUS_CAST } from "@money-maker/core/explainer/fixtures/cast/cost-curious-cast";
import { planMotion } from "@money-maker/core/explainer/motion/plan";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHyperFramesRenderer, DEFAULT_HYPERFRAMES_CLI } from "./hyperframes-renderer.js";

const wav = (): Uint8Array => {
  const data = new Uint8Array(4_800);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
};
const plan = planMotion({
  scenes: [
    {
      index: 1,
      fromChar: 0,
      toChar: 8,
      purpose: "hook",
      background: "grid",
      layoutId: "SOLO_CENTER",
      actors: [{ characterKey: "sam", pose: "neutral", expression: "happy", position: "center" }],
      props: [],
      overlays: [],
      camera: { shot: "medium", movement: "none" },
      transition: "hard_cut",
      captionMode: "word",
    },
  ],
  timings: [
    {
      startMs: 0,
      endMs: 2_000,
      voiceStartMs: 200,
      voiceEndMs: 500,
      text: "Hello you",
      words: [
        { text: "Hello", startMs: 200, endMs: 300 },
        { text: "you", startMs: 300, endMs: 500 },
      ],
    },
  ],
  characters: COST_CURIOUS_CAST,
  palette: DEFAULT_SCENE_PALETTE,
  captionWords: 3,
  durationMs: 2_000,
  canvas: "landscape",
});

// A stand-in CLI: records its argv, cwd, env and project files, then writes the output file.
const FAKE = `
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = args[args.indexOf("--output") + 1];
fs.writeFileSync(process.env.HF_DUMP, JSON.stringify({
  args, cwd: process.cwd(), files: fs.readdirSync(process.cwd()).sort(),
  telemetry: process.env.HYPERFRAMES_NO_TELEMETRY, update: process.env.HYPERFRAMES_NO_UPDATE_CHECK,
}));
if (process.env.HF_FAIL) process.exit(Number(process.env.HF_FAIL));
fs.writeFileSync(out, "mp4-bytes");
`;

describe("createHyperFramesRenderer", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hf-renderer-test-"));
    await writeFile(join(dir, "fake-cli.cjs"), FAKE);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const make = (env: Record<string, string>) =>
    createHyperFramesRenderer({
      cliCommand: [process.execPath, join(dir, "fake-cli.cjs")],
      tmpRoot: dir,
      timeoutMs: 20_000,
      env: { HF_DUMP: join(dir, "dump.json"), ...env },
    });
  const input = { plan, voiceClips: [wav()], voiceStartMs: [200] };

  it("pins the CLI version in the default command", () => {
    expect(DEFAULT_HYPERFRAMES_CLI).toEqual(["npx", "--yes", "hyperframes@0.8.112"]);
  });

  it("runs render in a temp project with telemetry and update checks off, then removes it", async () => {
    const output = await make({}).render(input);
    const dump = JSON.parse(await readFile(join(dir, "dump.json"), "utf8"));
    expect(dump.telemetry).toBe("1");
    expect(dump.update).toBe("1");
    expect(dump.args.slice(0, 1)).toEqual(["render"]);
    expect(dump.args).toContain("--quiet");
    expect(dump.args[dump.args.indexOf("--fps") + 1]).toBe("30");
    expect(dump.files).toEqual(expect.arrayContaining(["index.html", "voice-0.wav", "fonts"]));
    expect(Buffer.from(output.bytes).toString()).toBe("mp4-bytes");
    expect([output.width, output.height, output.durationMs]).toEqual([1920, 1080, 2_000]);
    expect(output.timings.encodeMs).toBeNull();
    expect((await readdir(dir)).filter((f) => f.startsWith("money-maker-render-"))).toEqual([]);
  });

  it("maps a CLI failure to hyperframes_render_failed:<code> and still cleans up", async () => {
    await expect(make({ HF_FAIL: "3" }).render(input)).rejects.toThrow(
      "hyperframes_render_failed:3",
    );
    expect((await readdir(dir)).filter((f) => f.startsWith("money-maker-render-"))).toEqual([]);
  });
});
