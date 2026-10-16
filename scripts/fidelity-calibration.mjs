// Product fidelity calibration harness (spec docs/superpowers/specs/2026-09-30-ai-video-generation-design.md
// section 8.6). It runs the same measurer and judge the worker uses, from their built output:
//
//   pnpm --filter @money-maker/core --filter @money-maker/providers build
//   node scripts/fidelity-calibration.mjs synthesize <photosDir> <pairsDir>
//   node scripts/fidelity-calibration.mjs measure <pairsDir> [--json <out.json>]
//
// Pairs layout: <pairsDir>/<productId>/original.<ext>, optional mask.png (white = product),
// good/<name>.<ext> and altered/<name>.<ext>, ext one of png, jpg, jpeg, webp. `synthesize`
// seeds that layout from real listing photos; human-labelled pairs go in the same folders.
// Keep photos and pairs out of Git (use tmp/, which .gitignore already excludes).

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, parse, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const load = async (path) => {
  try {
    return await import(pathToFileURL(join(root, path)).href);
  } catch (error) {
    console.error(`Cannot load ${path}. Run the build first:`);
    console.error("  pnpm --filter @money-maker/core --filter @money-maker/providers build");
    throw error;
  }
};
const sharp = createRequire(join(root, "packages/providers/package.json"))("sharp");
const { measureProductFidelity } = await load(
  "packages/providers/dist/src/media/sharp-fidelity-measurer.js",
);
const { ALTERATIONS, alterPhoto } = await load(
  "packages/providers/dist/src/media/fidelity-alterations.js",
);
const { removeWhiteBackground } = await load(
  "packages/providers/dist/src/media/white-background-remover.js",
);
const { classifyPicture } = await load("packages/providers/dist/src/media/picture-classifier.js");
const { judgeFidelity, PROVISIONAL_FIDELITY_THRESHOLDS } = await load(
  "packages/core/dist/creatives/product-fidelity.js",
);

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const METRICS = ["maskIou", "deltaE", "msSsim", "edgeRecall", "edgeExcess"];
const images = async (dir) =>
  (await readdir(dir).catch(() => []))
    .filter((name) => IMAGE.has(extname(name).toLowerCase()))
    .sort();

const synthesize = async (photosDir, pairsDir) => {
  for (const name of await images(photosDir)) {
    const id = parse(name).name;
    const photo = new Uint8Array(
      await sharp(await readFile(join(photosDir, name)))
        .rotate()
        .png()
        .toBuffer(),
    );
    const dir = join(pairsDir, id);
    await mkdir(join(dir, "good"), { recursive: true });
    await mkdir(join(dir, "altered"), { recursive: true });
    await writeFile(join(dir, "original.png"), photo);
    // A mask only when the existing white-background cutout applies; otherwise the whole photo
    // counts as product, which is what a framed render compares.
    if ((await classifyPicture(photo)).suggested === "local-white") {
      const cutout = await removeWhiteBackground(photo);
      await writeFile(
        join(dir, "mask.png"),
        await sharp(cutout.png).extractChannel(3).png().toBuffer(),
      );
    }
    for (const [kind, label] of Object.entries(ALTERATIONS))
      await writeFile(
        join(dir, label, `${kind}.${kind === "legit_jpeg" ? "jpg" : "png"}`),
        await alterPhoto(photo, kind),
      );
    console.log(`synthesized ${id}`);
  }
};

const nearestRank = (sorted, q) =>
  sorted.length === 0
    ? null
    : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
const round = (value) => (value === null ? null : Math.round(value * 1000) / 1000);

const measure = async (pairsDir, jsonPath) => {
  const rows = [];
  for (const id of (await readdir(pairsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    const dir = join(pairsDir, id);
    const originalName = (await images(dir)).find((name) => parse(name).name === "original");
    if (!originalName) {
      console.warn(`skip ${id}: no original.<ext>`);
      continue;
    }
    const original = new Uint8Array(await readFile(join(dir, originalName)));
    const mask = await readFile(join(dir, "mask.png")).then(
      (bytes) => new Uint8Array(bytes),
      () => undefined,
    );
    for (const label of ["good", "altered"])
      for (const name of await images(join(dir, label))) {
        const rendered = new Uint8Array(await readFile(join(dir, label, name)));
        const { width = 0, height = 0 } = await sharp(rendered).metadata();
        const metrics = await measureProductFidelity({
          original,
          rendered,
          region: { x: 0, y: 0, w: width, h: height },
          ...(mask ? { mask } : {}),
        });
        const report = judgeFidelity(metrics, PROVISIONAL_FIDELITY_THRESHOLDS);
        rows.push({ id, label, name, ...report });
      }
  }
  const summary = [];
  for (const label of ["good", "altered"])
    for (const metric of METRICS) {
      const values = rows
        .filter((row) => row.label === label && typeof row[metric] === "number")
        .map((row) => row[metric])
        .sort((a, b) => a - b);
      summary.push({
        label,
        metric,
        n: values.length,
        min: round(values[0] ?? null),
        p10: round(nearestRank(values, 0.1)),
        median: round(nearestRank(values, 0.5)),
        p90: round(nearestRank(values, 0.9)),
        max: round(values.at(-1) ?? null),
      });
    }
  console.table(summary);
  const verdicts = ["good", "altered"].map((label) => ({
    label,
    ...Object.fromEntries(
      ["pass", "warn", "block"].map((verdict) => [
        verdict,
        rows.filter((row) => row.label === label && row.verdict === verdict).length,
      ]),
    ),
  }));
  console.log(`Verdicts with threshold set ${PROVISIONAL_FIDELITY_THRESHOLDS.id}:`);
  console.table(verdicts);
  const misjudged = rows.filter(
    (row) =>
      (row.label === "good" && row.verdict === "block") ||
      (row.label === "altered" && row.verdict === "pass"),
  );
  for (const row of misjudged)
    console.log(
      `MISJUDGED ${row.label} ${row.id}/${row.name}: ${row.verdict} ${row.reasons.join(",")}`,
    );
  if (jsonPath)
    await writeFile(jsonPath, `${JSON.stringify({ summary, verdicts, rows }, null, 1)}\n`);
};

const [command, first, second, third] = process.argv.slice(2);
if (command === "synthesize" && first && second) await synthesize(first, second);
else if (command === "measure" && first)
  await measure(first, second === "--json" ? third : undefined);
else {
  console.error("usage: node scripts/fidelity-calibration.mjs synthesize <photosDir> <pairsDir>");
  console.error(
    "       node scripts/fidelity-calibration.mjs measure <pairsDir> [--json <out.json>]",
  );
  process.exit(2);
}
