#!/usr/bin/env node
// Drafts the music folder's manifest.json (packages/providers/src/media/folder-music-library.ts)
// from the licence files kept next to each track: "<track.m4a>.LICENSE.txt", "<track>.LICENSE.txt"
// or "LICENSE.txt" in the same folder. The licence is the "License:" line (else the first line).
// Meta Sound Collection tracks are limited to Instagram and Facebook, TikTok Commercial Music
// Library tracks to TikTok. Tracks with no licence file are listed and left out, so they stop
// playing once the manifest exists. Tempo (bpm) is never guessed: add it by hand.
//   node scripts/music-manifest.mjs <music root>           print the draft
//   node scripts/music-manifest.mjs <music root> --write   write <root>/manifest.json
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";

const [root, flag] = process.argv.slice(2);
if (!root) {
  console.error("usage: node scripts/music-manifest.mjs <music root> [--write]");
  process.exit(2);
}
const audio = /^[a-z0-9][a-z0-9._-]*\.(mp3|m4a|aac|wav)$/i;
const moods = new Set(["energetic", "upbeat", "calm", "elegant"]);
const dirs = async (path) =>
  (await readdir(path, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && /^[a-z0-9-]+$/.test(entry.name))
    .map((entry) => entry.name);
const licenceOf = async (path) => {
  const lines = (await readFile(path, "utf8").catch(() => ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tagged = lines.find((line) => /^licen[cs]e\s*:/i.test(line));
  return tagged ? tagged.replace(/^licen[cs]e\s*:\s*/i, "") : lines[0];
};
const platformsOf = (licence) =>
  /meta sound collection|inside meta products/i.test(licence)
    ? ["instagram", "facebook"]
    : /tiktok commercial music library|commercial music library/i.test(licence)
      ? ["tiktok"]
      : undefined;

const previous = JSON.parse(
  await readFile(join(root, "manifest.json"), "utf8").catch(() => '{"tracks":{}}'),
).tracks;
const tracks = {};
const missing = [];
for (const niche of await dirs(root))
  for (const mood of (await dirs(join(root, niche))).filter((name) => moods.has(name))) {
    const folder = join(root, niche, mood);
    for (const file of (await readdir(folder)).filter((name) => audio.test(name)).sort()) {
      const id = `${niche}/${mood}/${file}`;
      const license =
        (await licenceOf(join(folder, `${file}.LICENSE.txt`))) ??
        (await licenceOf(join(folder, `${parse(file).name}.LICENSE.txt`))) ??
        (await licenceOf(join(folder, "LICENSE.txt")));
      if (!license) {
        missing.push(id);
        continue;
      }
      // A tempo already in the manifest is kept.
      const bpm = previous?.[id]?.bpm;
      const platforms = platformsOf(license);
      tracks[id] = {
        license,
        ...(typeof bpm === "number" ? { bpm } : {}),
        ...(platforms ? { platforms } : {}),
      };
    }
  }
const manifest = `${JSON.stringify({ tracks }, null, 2)}\n`;
if (flag === "--write") await writeFile(join(root, "manifest.json"), manifest);
else process.stdout.write(manifest);
console.error(
  `${Object.keys(tracks).length} licensed track(s); ${missing.length} without a licence file${
    missing.length ? `:\n  ${missing.join("\n  ")}` : ""
  }`,
);
