import { join, resolve } from "node:path";
import {
  productVisualSpecFor,
  vlmFidelityPrompt,
  vlmPlacementJsonSchema,
  vlmPlacementPrompt,
} from "@money-maker/core/creatives/in-scene-fidelity";
import { realProductsInterleaved } from "@money-maker/core/arena/real-dataset";
import { refImage } from "../arena/suites/visual.js";
import { readImage, startVlmJudge } from "../arena/vlm-judge.js";
import { detectTarget, environment } from "./arena-run.js";

/**
 * Count-gate calibration (brief 11.2 / 20): asks the vision judge to count one feature in a set
 * of scenes whose true count was checked by eye, under several prompt shapes, and prints the
 * hits per prompt. `--dir` holds scene-N.png, `--ref` the listing photo, `--key` the feature,
 * `--truth=1:3,2:4,...` the eye counts, `--title` the offer title for the production prompt.
 */
const flag = (args: readonly string[], name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const schema = (key: string) => ({
  type: "object",
  additionalProperties: false,
  required: [key],
  properties: { [key]: { type: ["integer", "null"], minimum: 0, maximum: 50 } },
});
const listSchema = (key: string) => ({
  type: "object",
  additionalProperties: false,
  required: ["boards", key],
  properties: {
    boards: { type: "array", maxItems: 12, items: { type: "string", maxLength: 80 } },
    [key]: { type: ["integer", "null"], minimum: 0, maximum: 50 },
  },
});

export const countPrompts = (key: string, title: string) => ({
  production: {
    prompt: vlmFidelityPrompt(productVisualSpecFor(title)),
    withReference: true,
    schema: null,
  },
  scene_only: {
    prompt: `Count the ${key} of the shelving product in this image: every horizontal board from the top one to the bottom one, the bottom board included. Answer JSON {"${key}": n}.`,
    withReference: false,
    schema: schema(key),
  },
  list_then_count: {
    prompt: `Look at the shelving product in this image. List its horizontal boards from top to bottom, one short line each (what sits on it or "empty"), then give the total. Answer JSON {"boards": [...], "${key}": n}.`,
    withReference: false,
    schema: listSchema(key),
  },
  reference_then_scene: {
    prompt: `Image 1 is the product photo, image 2 an illustration. Count the horizontal boards of the shelving product in image 2 only, bottom board included; do not copy the count from image 1. Answer JSON {"${key}": n}.`,
    withReference: true,
    schema: schema(key),
  },
});

/** `--placement --truth=1:ok,5:bad` asks the placement question instead of the counts. */
const placementProbe = async (
  judge: Awaited<ReturnType<typeof startVlmJudge>>,
  dir: string,
  truth: ReadonlyMap<number, string>,
  title: string,
): Promise<void> => {
  let hits = 0;
  console.log("| scene | eye | resting on | note |");
  console.log("|---|---|---|---|");
  for (const [index, expected] of truth) {
    const raw = (await judge
      .ask({
        prompt: vlmPlacementPrompt(title),
        images: [await readImage(join(dir, `scene-${index}.png`))],
        schemaName: "placement",
        schema: vlmPlacementJsonSchema(),
      })
      .catch(() => null)) as { restingOn?: string; note?: string } | null;
    const got = raw?.restingOn ?? "?";
    if (got === expected) hits += 1;
    console.log(
      `| ${index} | ${expected} | ${got}${got === expected ? "" : " ✗"} | ${raw?.note ?? ""} |`,
    );
  }
  console.log(`| hits | ${truth.size} | ${hits} | |`);
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const dir = resolve(flag(args, "dir") ?? ".");
  const key = flag(args, "key") ?? "shelves";
  const pairs = (flag(args, "truth") ?? "").split(",").map((pair) => pair.split(":"));
  const truth = new Map(pairs.map(([index, count]) => [Number(index), Number(count)] as const));
  const env = environment(await detectTarget(), resolve(process.cwd()), "real");
  // `--product=<arena id>` takes the listing photo and title from the real dataset.
  const product = realProductsInterleaved().find((p) => p.id === flag(args, "product"));
  const reference = product
    ? await refImage(env, product.photo)
    : await readImage(resolve(flag(args, "ref") ?? join(dir, "reference.jpg")));
  const judge = await startVlmJudge(env);
  if (args.includes("--placement")) {
    try {
      await placementProbe(
        judge,
        dir,
        new Map(pairs.map(([i, v]) => [Number(i), v ?? ""])),
        flag(args, "title") ?? product?.title ?? "",
      );
    } finally {
      await judge.stop();
    }
    return;
  }
  const prompts = countPrompts(key, flag(args, "title") ?? product?.title ?? "");
  const rows: string[] = [];
  const hits = new Map<string, number>();
  try {
    for (const [index, expected] of truth) {
      const scene = await readImage(join(dir, `scene-${index}.png`));
      const cells: string[] = [];
      for (const [name, variant] of Object.entries(prompts)) {
        const raw = await judge
          .ask({
            prompt: variant.prompt,
            images: variant.withReference ? [reference, scene] : [scene],
            schemaName: `count_${name}`,
            schema: variant.schema ?? {
              type: "object",
              properties: { counts: { type: "object" } },
              required: ["counts"],
            },
          })
          .catch(() => null);
        const record = (raw ?? {}) as Record<string, unknown>;
        const counted =
          name === "production"
            ? ((record.counts as Record<string, unknown> | undefined)?.[key] ?? null)
            : (record[key] ?? null);
        const hit = counted === expected;
        if (hit) hits.set(name, (hits.get(name) ?? 0) + 1);
        cells.push(`${String(counted)}${hit ? "" : " ✗"}`);
      }
      rows.push(`| ${index} | ${expected} | ${cells.join(" | ")} |`);
    }
  } finally {
    await judge.stop();
  }
  const names = Object.keys(prompts);
  console.log(`| scene | eye | ${names.join(" | ")} |`);
  console.log(`|---|---|${names.map(() => "---").join("|")}|`);
  for (const row of rows) console.log(row);
  console.log(
    `| hits | ${truth.size} | ${names.map((name) => String(hits.get(name) ?? 0)).join(" | ")} |`,
  );
};

if (process.argv[1]?.endsWith("count-probe.js")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
