import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";
import {
  cloudGenerationAllowed,
  parseGenerationPolicy,
} from "@money-maker/core/assets/generation-policy";
import { type BurnInResult, runBurnIn } from "@money-maker/core/autonomy/burn-in";
import { listAutonomyWorkspaces } from "@money-maker/core/autonomy/cycle";
import { createDatabaseClient } from "@money-maker/providers/database/client";
import { PrismaPublicationPolicyRepository } from "@money-maker/providers/database/publication-policy-repository";
import { createMarketplaceCatalogForWorkspace } from "@money-maker/providers/mercado-livre/workspace-catalog";
import { buildAutonomyDeps } from "../autonomy-deps.js";

export type BurnInArgs = Readonly<{
  hours: number;
  intervalMin: number;
  workspaces: readonly string[];
  noPublish: boolean;
  out: string | null;
}>;

export const parseBurnInArgs = (argv: readonly string[]): BurnInArgs => {
  let hours = 24;
  let intervalMin = 10;
  let noPublish = false;
  let out: string | null = null;
  const workspaces: string[] = [];
  for (const arg of argv) {
    const [flag, value = ""] = arg.split(/=(.*)/s);
    if (flag === "--no-publish") noPublish = true;
    else if (flag === "--hours") hours = Number(value);
    else if (flag === "--interval-min") intervalMin = Number(value);
    else if (flag === "--workspace") workspaces.push(value);
    else if (flag === "--out") out = value;
    else throw new Error(`unknown_argument:${flag}`);
  }
  if (!Number.isFinite(hours) || hours <= 0) throw new Error("invalid_hours");
  if (!Number.isFinite(intervalMin) || intervalMin <= 0) throw new Error("invalid_interval_min");
  return { hours, intervalMin, workspaces, noPublish, out };
};

/** Reasons to refuse to start; empty means safe. Modes are each workspace's publication policy. */
export const burnInRefusals = (input: {
  noPublish: boolean;
  generationPolicy: string | undefined;
  publicationModes: Readonly<Record<string, string>>;
}): readonly string[] => {
  const refusals: string[] = [];
  if (!input.noPublish) refusals.push("--no-publish is required");
  try {
    // local_only is the only policy under which no paid generation provider is effective.
    if (cloudGenerationAllowed(parseGenerationPolicy(input.generationPolicy)))
      refusals.push("GENERATION_POLICY must be local_only");
  } catch {
    refusals.push("GENERATION_POLICY is invalid; it must be local_only");
  }
  for (const [workspaceId, mode] of Object.entries(input.publicationModes))
    if (mode !== "paused" && mode !== "manual")
      refusals.push(`publication policy of ${workspaceId} is ${mode}; must be paused or manual`);
  return refusals;
};

const sleepUnlessAborted = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

const main = async (): Promise<void> => {
  const args = parseBurnInArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  const secret = process.env.SECRET_STORE_MASTER_KEY;
  if (!databaseUrl || !secret)
    throw new Error("DATABASE_URL and SECRET_STORE_MASTER_KEY are required");
  const generationPolicy = process.env.GENERATION_POLICY;
  // Fail on the cheap checks before touching the database.
  const early = burnInRefusals({ ...args, generationPolicy, publicationModes: {} });
  if (early.length > 0) throw new Error(`refused: ${early.join("; ")}`);

  const client = createDatabaseClient(databaseUrl);
  try {
    const deps = buildAutonomyDeps(
      client,
      createMarketplaceCatalogForWorkspace({
        client,
        secretStoreMasterKey: Buffer.from(secret, "base64url"),
      }),
      { generationPolicy: parseGenerationPolicy(generationPolicy), autonomyEnabled: false },
    );
    const workspaceIds: readonly WorkspaceId[] =
      args.workspaces.length > 0
        ? args.workspaces.map(parseWorkspaceId)
        : await listAutonomyWorkspaces(deps.cycle.policies, new Date());
    if (workspaceIds.length === 0)
      throw new Error("no workspaces to run (no active research policy)");

    const publicationPolicies = new PrismaPublicationPolicyRepository(client);
    const publicationModes: Record<string, string> = {};
    for (const id of workspaceIds)
      publicationModes[id] = (await publicationPolicies.findForWorkspace(id)).mode;
    const refusals = burnInRefusals({ ...args, generationPolicy, publicationModes });
    if (refusals.length > 0) throw new Error(`refused: ${refusals.join("; ")}`);

    const startedAt = new Date();
    const out =
      args.out ??
      join("autonomy-burn-in-out", `${startedAt.toISOString().replaceAll(":", "-")}.json`);
    await mkdir(dirname(out), { recursive: true });
    const write = (result: BurnInResult) =>
      writeFile(
        out,
        JSON.stringify(
          { config: { generationPolicy, publicationModes, noPublish: true }, result },
          null,
          2,
        ),
      );

    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => controller.abort());
    const final = await runBurnIn(deps, {
      workspaceIds,
      hours: args.hours,
      intervalMs: args.intervalMin * 60_000,
      clock: { now: () => new Date(), sleep: (ms) => sleepUnlessAborted(ms, controller.signal) },
      signal: controller.signal,
      onCycle: write,
    });
    console.info("burn_in_done", { out, cycles: final.cycles, stoppedBy: final.stoppedBy });
  } finally {
    await client.$disconnect();
  }
};

if (process.argv[1]?.endsWith("autonomy-burn-in.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "burn-in failed");
    process.exitCode = 1;
  });
}
