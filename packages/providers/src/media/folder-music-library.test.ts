import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFolderMusicLibrary } from "./folder-music-library.js";

describe("createFolderMusicLibrary", () => {
  it("lists <niche>/<mood>/<file> audio tracks and skips everything else", async () => {
    const root = await mkdtemp(join(tmpdir(), "music-"));
    try {
      await mkdir(join(root, "casa", "calm"), { recursive: true });
      await mkdir(join(root, "casa", "sad"), { recursive: true });
      await mkdir(join(root, "geral", "upbeat"), { recursive: true });
      await writeFile(join(root, "casa", "calm", "manha-leve.mp3"), "x");
      await writeFile(join(root, "casa", "calm", "manha-leve.LICENSE.txt"), "x");
      await writeFile(join(root, "casa", "sad", "chuva.mp3"), "x");
      await writeFile(join(root, "geral", "upbeat", "sol.m4a"), "x");
      await writeFile(join(root, "loose.mp3"), "x");
      await expect(createFolderMusicLibrary(root).listTracks()).resolves.toEqual([
        {
          id: "casa/calm/manha-leve.mp3",
          niche: "casa",
          mood: "calm",
          file: join(root, "casa", "calm", "manha-leve.mp3"),
        },
        {
          id: "geral/upbeat/sol.m4a",
          niche: "geral",
          mood: "upbeat",
          file: join(root, "geral", "upbeat", "sol.m4a"),
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("with a manifest lists only licensed tracks, with licence and tempo", async () => {
    const root = await mkdtemp(join(tmpdir(), "music-"));
    try {
      await mkdir(join(root, "casa", "calm"), { recursive: true });
      await writeFile(join(root, "casa", "calm", "a.mp3"), "x");
      await writeFile(join(root, "casa", "calm", "b.mp3"), "x");
      await writeFile(join(root, "casa", "calm", "c.mp3"), "x");
      await writeFile(
        join(root, "manifest.json"),
        JSON.stringify({
          tracks: {
            "casa/calm/a.mp3": { license: "Pixabay Content License", bpm: 120 },
            "casa/calm/b.mp3": { license: " " },
            "casa/calm/c.mp3": { license: "CC0", bpm: 999 },
          },
        }),
      );
      await expect(createFolderMusicLibrary(root).listTracks()).resolves.toEqual([
        expect.objectContaining({
          id: "casa/calm/a.mp3",
          license: "Pixabay Content License",
          bpm: 120,
        }),
        {
          id: "casa/calm/c.mp3",
          niche: "casa",
          mood: "calm",
          file: join(root, "casa", "calm", "c.mp3"),
          license: "CC0",
        },
      ]);
      // A malformed manifest licenses nothing: silence beats an unlicensed track.
      await writeFile(join(root, "manifest.json"), "{oops");
      await expect(createFolderMusicLibrary(root).listTracks()).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("carries the platforms a licence allows and refuses an unknown platform", async () => {
    const root = await mkdtemp(join(tmpdir(), "music-"));
    try {
      await mkdir(join(root, "casa", "calm"), { recursive: true });
      await writeFile(join(root, "casa", "calm", "meta.m4a"), "x");
      await writeFile(join(root, "casa", "calm", "odd.m4a"), "x");
      await writeFile(
        join(root, "manifest.json"),
        JSON.stringify({
          tracks: {
            "casa/calm/meta.m4a": {
              license: "Meta Sound Collection",
              platforms: ["instagram", "facebook"],
            },
            "casa/calm/odd.m4a": { license: "x", platforms: ["myspace"] },
          },
        }),
      );
      await expect(createFolderMusicLibrary(root).listTracks()).resolves.toEqual([
        expect.objectContaining({ id: "casa/calm/meta.m4a", platforms: ["instagram", "facebook"] }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a missing root as an empty library", async () => {
    await expect(createFolderMusicLibrary("/nonexistent/music").listTracks()).resolves.toEqual([]);
  });
});
