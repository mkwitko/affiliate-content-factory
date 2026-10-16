import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";
import {
  type SceneClipGenerator,
  SceneClipSubmitError,
} from "@money-maker/core/assets/scene-clip-generator";
import { modalQuote } from "@money-maker/core/cloud-gpu/modal-quote";
import { type BudgetReservation, quoteBrlMinor } from "@money-maker/core/costs/generation-budget";
import {
  DEFAULT_GENERATION_SETTINGS,
  paidBudgetPolicy,
} from "@money-maker/core/costs/generation-settings";
import {
  createModalCalls,
  createModalSceneClipGenerator,
  createR2ClipObjectStore,
  MODAL_PILOT,
} from "@money-maker/providers/cloud-gpu/modal-scene-clip-generator";
import { fetchPtaxUsdBrl, type PtaxRate } from "@money-maker/providers/cloud-gpu/ptax";
import { createDatabaseClient } from "@money-maker/providers/database/client";
import { PrismaGenerationBudgetLedger } from "@money-maker/providers/database/generation-budget-ledger";
import { checkSceneClip } from "@money-maker/providers/media/scene-clip-check";
import { createR2S3SigningClient } from "@money-maker/providers/storage/r2-s3-signing-client";

/**
 * One supervised Modal clip outside production (cloud GPU pilot, first real experiment).
 *
 *   node --env-file=<repo>/.env dist/commands/cloud-clip-trial.js \
 *     --workspace <id> --image <local png/jpeg> --prompt "<motion>" [--negative "<text>"] \
 *     [--landscape] [--out <dir>] [--execute]
 *
 * Without --execute it only prints the worst-case quote: no upload, no reservation, no GPU.
 * With --execute: plate to R2 under cloud-gpu/trials/, one Modal call through the production
 * adapter (budget reserved first, one attempt), the existing clip QA, MP4 written to --out for
 * the owner's review. Nothing enters the content system. The ledger lives in TRIAL_DATABASE_URL
 * (a local Postgres), never the production database.
 */
const requireEnv = (value: string | undefined, name: string): string => {
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export type TrialArgs = Readonly<{
  workspaceId: WorkspaceId;
  image: string;
  prompt: string;
  negative: string;
  landscape: boolean;
  out: string;
  execute: boolean;
}>;

export type TrialDeps = Readonly<{
  readImage(path: string): Promise<Uint8Array>;
  putPlate(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  plateUrl(key: string): Promise<string>;
  generator: SceneClipGenerator;
  fx(): Promise<PtaxRate | null>;
  fetchClip(url: string): Promise<Uint8Array>;
  checkClip(
    bytes: Uint8Array,
    expected: Readonly<{ width: number; height: number; seconds: number }>,
  ): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>>;
  writeClip(path: string, bytes: Uint8Array): Promise<void>;
  reservations(): Promise<readonly BudgetReservation[]>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}>;

const POLL_MS = 15_000;

export const parseTrialArgs = (argv: readonly string[]): TrialArgs => {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    const found = index >= 0 ? argv[index + 1] : undefined;
    return found && !found.startsWith("--") ? found : undefined;
  };
  const required = (name: string) => {
    const found = value(name);
    if (!found) throw new Error(`cloud_clip_trial_flag_missing:${name}`);
    return found;
  };
  return {
    workspaceId: parseWorkspaceId(required("workspace")),
    image: required("image"),
    prompt: required("prompt"),
    negative: value("negative") ?? "text, captions, watermark, extra people, deformed hands",
    landscape: argv.includes("--landscape"),
    out: value("out") ?? "cloud-clip-trial-out",
    execute: argv.includes("--execute"),
  };
};

export const runCloudClipTrial = async (deps: TrialDeps, args: TrialArgs) => {
  const plate = await deps.readImage(args.image);
  const sha = createHash("sha256").update(plate).digest("hex");
  const contentType = plate[0] === 0x89 ? "image/png" : plate[0] === 0xff ? "image/jpeg" : null;
  if (!contentType) throw new Error("cloud_clip_trial_image_not_png_or_jpeg");
  const size = args.landscape ? { width: 1280, height: 720 } : { width: 720, height: 1280 };
  const fx = await deps.fx();
  const worstCaseMinor = fx
    ? quoteBrlMinor(
        modalQuote({
          shape: MODAL_PILOT.shape,
          model: MODAL_PILOT.model.id,
          revision: MODAL_PILOT.model.revision,
          fx,
          now: deps.now(),
        }),
      )
    : null;
  const operationKey = `trial:${sha.slice(0, 16)}:${createHash("sha256").update(args.prompt).digest("hex").slice(0, 8)}`;
  const base = { operationKey, plateSha256: sha, worstCaseMinor, fx: fx?.source ?? null, ...size };
  if (!args.execute) return { mode: "dry_run" as const, ...base };

  const key = `workspaces/${args.workspaceId}/cloud-gpu/trials/${sha}.${contentType === "image/png" ? "png" : "jpg"}`;
  await deps.putPlate(key, plate, contentType);
  const started = deps.now().getTime();
  let task: Awaited<ReturnType<SceneClipGenerator["submit"]>>;
  try {
    task = await deps.generator.submit({
      prompt: args.prompt,
      negativePrompt: args.negative,
      mode: "image",
      referenceImageUrls: [await deps.plateUrl(key)],
      referenceChecksums: [`sha256:${sha}`],
      ...size,
      seconds: 5,
      budget: { workspaceId: args.workspaceId, operationKey },
    });
  } catch (error) {
    if (!(error instanceof SceneClipSubmitError)) throw error;
    return {
      mode: "refused" as const,
      ...base,
      code: error.code,
      ledger: await deps.reservations(),
    };
  }
  const submittedAt = task.submittedAt ?? deps.now().toISOString();
  for (;;) {
    const polled = await deps.generator.poll({ ...task, submittedAt });
    const seconds = Math.round((deps.now().getTime() - started) / 1000);
    if (polled.status === "pending") {
      await deps.sleep(POLL_MS);
      continue;
    }
    const ledger = await deps.reservations();
    if (polled.status === "failed")
      return { mode: "failed" as const, ...base, code: polled.code, seconds, ledger };
    const clip = await deps.fetchClip(polled.url);
    const verdict = await deps.checkClip(clip, { ...size, seconds: 5 });
    const path = join(args.out, `${operationKey.replaceAll(":", "_")}.mp4`);
    await deps.writeClip(path, clip);
    return { mode: "completed" as const, ...base, seconds, verdict, path, ledger };
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const trialDb = env.TRIAL_DATABASE_URL;
  if (
    !trialDb ||
    trialDb === env.DATABASE_URL ||
    trialDb === env.DIRECT_URL ||
    /neon\.tech/.test(trialDb)
  )
    throw new Error(
      "TRIAL_DATABASE_URL must name a local Postgres, never the production database.",
    );
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET)
    throw new Error("R2_* variables are required.");
  const args = parseTrialArgs(process.argv.slice(2));
  const client = createDatabaseClient(trialDb);
  try {
    // The local ledger's cost_events rows need their workspace row.
    await client.workspace.upsert({
      where: { id: args.workspaceId },
      create: { id: args.workspaceId, name: "cloud clip trial" },
      update: {},
    });
    const ledger = new PrismaGenerationBudgetLedger(client);
    const signing = createR2S3SigningClient({
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucketName: env.R2_BUCKET,
    });
    const fx = () => fetchPtaxUsdBrl(new Date());
    const policy = paidBudgetPolicy(DEFAULT_GENERATION_SETTINGS, ["modal"], new Date());
    const report = await runCloudClipTrial(
      {
        readImage: async (path) => new Uint8Array(await readFile(path)),
        putPlate: (key, body, contentType) =>
          signing.putObject({ key, body, contentType, metadata: {} }),
        plateUrl: (key) => signing.createDownloadUrl({ key, expiresInSeconds: 1800 }),
        generator: createModalSceneClipGenerator({
          // The owner's Modal token from the environment of this one run (never a file).
          calls: createModalCalls({
            token: {
              id: requireEnv(env.MODAL_TOKEN_ID, "MODAL_TOKEN_ID"),
              secret: requireEnv(env.MODAL_TOKEN_SECRET, "MODAL_TOKEN_SECRET"),
            },
            app: MODAL_PILOT.app,
            functionName: MODAL_PILOT.functionName,
          }),
          store: createR2ClipObjectStore(signing),
          ledger,
          policies: [policy],
          shape: MODAL_PILOT.shape,
          model: MODAL_PILOT.model,
          fx,
        }),
        fx,
        fetchClip: async (url) => {
          const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
          if (!response.ok) throw new Error(`cloud_clip_trial_download_${response.status}`);
          return new Uint8Array(await response.arrayBuffer());
        },
        checkClip: (bytes, expected) => checkSceneClip(bytes, expected),
        writeClip: async (path, bytes) => {
          await mkdir(args.out, { recursive: true });
          await writeFile(path, bytes);
        },
        reservations: () => ledger.list({ workspaceId: args.workspaceId, budgetKey: policy.key }),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => new Date(),
      },
      args,
    );
    console.log(JSON.stringify(report, null, 1));
  } finally {
    await client.$disconnect();
  }
}
