import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type MusicLibrary,
  type MusicPlatform,
  type MusicTrack,
  musicPlatforms,
  type ReelMood,
  reelMoods,
} from "@money-maker/core/assets/reel-music";

const audioFile = /^[a-z0-9][a-z0-9._-]*\.(mp3|m4a|aac|wav)$/i;
const folderName = /^[a-z0-9-]+$/;

const listDirectories = async (path: string): Promise<string[]> =>
  (await readdir(path, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && folderName.test(entry.name))
    .map((entry) => entry.name);

type ManifestEntry = Readonly<{ license: string; bpm?: number; platforms?: MusicPlatform[] }>;

/**
 * `<root>/manifest.json`: `{ "tracks": { "<niche>/<mood>/<file>": { "license": "...",
 * "bpm": 120, "platforms": ["instagram", "facebook"] } } }`. Null when absent; a malformed file is an empty manifest (nothing plays
 * rather than an unlicensed track).
 */
const readManifest = async (root: string): Promise<Map<string, ManifestEntry> | null> => {
  const entries = new Map<string, ManifestEntry>();
  // Only a missing file means "no manifest"; an unreadable one licenses nothing.
  const text = await readFile(join(root, "manifest.json"), "utf8").catch((error: unknown) =>
    (error as { code?: unknown }).code === "ENOENT" ? null : "",
  );
  if (text === null) return null;
  try {
    const tracks = (JSON.parse(text) as { tracks?: unknown }).tracks;
    if (typeof tracks !== "object" || tracks === null) return entries;
    for (const [id, raw] of Object.entries(tracks)) {
      const { license, bpm, platforms } = (raw ?? {}) as {
        license?: unknown;
        bpm?: unknown;
        platforms?: unknown;
      };
      if (typeof license !== "string" || !license.trim()) continue;
      const tempo = typeof bpm === "number" && bpm >= 40 && bpm <= 240 ? bpm : undefined;
      // A platform list with an unknown entry licenses nothing, never everything.
      if (platforms !== undefined) {
        const known: readonly string[] = musicPlatforms;
        if (
          !Array.isArray(platforms) ||
          platforms.length === 0 ||
          !platforms.every((p) => typeof p === "string" && known.includes(p))
        )
          continue;
      }
      entries.set(id, {
        license: license.trim(),
        ...(tempo ? { bpm: tempo } : {}),
        ...(platforms ? { platforms: [...new Set(platforms as MusicPlatform[])] } : {}),
      });
    }
  } catch {
    return entries;
  }
  return entries;
};

/**
 * Reads the owner's licensed tracks laid out as <root>/<niche>/<mood>/<file>. Unknown moods,
 * odd names, and non-audio files (such as a LICENSE.txt next to each track) are skipped; a
 * missing root is an empty library. With a `manifest.json` only tracks it licenses are listed,
 * carrying their licence and tempo. Read on every call, so new tracks need no restart.
 */
export const createFolderMusicLibrary = (root: string): MusicLibrary => ({
  async listTracks(): Promise<readonly MusicTrack[]> {
    const manifest = await readManifest(root);
    const tracks: MusicTrack[] = [];
    for (const niche of await listDirectories(root)) {
      for (const mood of await listDirectories(join(root, niche))) {
        if (!(reelMoods as readonly string[]).includes(mood)) continue;
        const files = await readdir(join(root, niche, mood)).catch(() => [] as string[]);
        for (const file of files.filter((name) => audioFile.test(name)).sort()) {
          const id = `${niche}/${mood}/${file}`;
          const entry = manifest?.get(id);
          if (manifest && !entry) continue;
          tracks.push({
            id,
            niche,
            mood: mood as ReelMood,
            file: join(root, niche, mood, file),
            ...entry,
          });
        }
      }
    }
    return tracks;
  },
});
